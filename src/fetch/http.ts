/**
 * The guarded fetch (SPEC.md §8).
 *
 * This is the only place in the system that opens a connection to the public
 * internet, and the only process that handles what comes back. Four things make
 * it a boundary rather than an HTTP helper:
 *
 *   DNS is resolved here, once, and the connection is PINNED to an address this
 *   module validated. undici is given a `lookup` that returns only that
 *   address, so the client cannot resolve the name a second time and reach
 *   somewhere else between the check and the connect. That window — validate
 *   one address, let the client pick another — is DNS rebinding, and closing it
 *   is the whole point of resolving first.
 *
 *   Redirects are followed by this module, never by undici. undici 8 follows
 *   none unless its redirect interceptor is added, and this never adds it, so
 *   a 3xx arrives here as an ordinary response. Every hop then goes through the
 *   full check again: scheme, port, resolve, classify. A redirect the client
 *   followed itself would resolve the new host with its own DNS and bypass
 *   every control above — a test asserts it does not.
 *
 *   The body is streamed against a byte budget and abandoned the moment it is
 *   exceeded. Nothing is buffered first and measured afterwards, so a 100 MB
 *   response costs 2 MB of memory and one aborted socket.
 *
 *   Accept-Encoding is identity. The cap then applies to the bytes that
 *   actually become text, and a response that expands a thousandfold when
 *   decompressed is not a thing that can happen.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';

import { Agent, request } from 'undici';

import { classifyAddress } from './ssrf';
import { FROZEN_POLICY, type FetchPolicy } from './policy';

/** Why a fetch was refused. Stable strings: the handler and tests match on them. */
export type FetchRefusal =
  | 'url_has_credentials'
  | 'scheme_not_allowed'
  | 'port_not_allowed'
  | 'dns_failed'
  | 'address_blocked'
  | 'too_many_redirects'
  | 'redirect_without_location'
  | 'content_type_not_allowed'
  | 'body_too_large'
  | 'timeout'
  | 'transport_error';

export class FetchRefused extends Error {
  override readonly name = 'FetchRefused';

  constructor(
    readonly refusal: FetchRefusal,
    message: string,
    /** The hop that was refused, which is not always the hop requested. */
    readonly url?: string,
  ) {
    super(message);
  }
}

export interface FetchOutcome {
  readonly finalUrl: string;
  readonly httpStatus: number;
  readonly contentType: string;
  /** The response body, and empty for any non-2xx status — see guardedFetch. */
  readonly body: string;
  readonly bytes: number;
  /** Every URL in the chain, first requested to final. */
  readonly chain: readonly string[];
  readonly truncated: false;
}

/** Validates a URL's shape. Cheap, and never the only check. */
export function assertAllowedUrl(target: URL, policy: FetchPolicy): void {
  // Credentials in the URL, before anything else happens.
  //
  // The URL comes from a job payload, so a username or password in it is an
  // attempt to make the fetcher authenticate as somebody — and it is refused
  // whether or not the HTTP client would actually transmit it. undici 8 does
  // not send an Authorization header for userinfo, but that is a property of
  // this client version, not a guarantee: a different version, or a switch to
  // global fetch, could start sending it.
  //
  // The concrete harm does not need the header at all. url and final_url are
  // persisted on the snapshot and returned to the worker, so accepting
  // http://user:pass@host/ would write a credential into web_snapshots.url in
  // plaintext and log it — which §17 forbids outright.
  //
  // Checked here means checked on every redirect hop too, because every hop
  // re-enters this function.
  if (target.username !== '' || target.password !== '') {
    throw new FetchRefused(
      'url_has_credentials',
      'the URL carries userinfo credentials, which a job may not introduce',
      // Deliberately not target.href: that is the string holding the secret.
      `${target.protocol}//${target.host}${target.pathname}`,
    );
  }

  if (!policy.allowedSchemes.includes(target.protocol)) {
    throw new FetchRefused(
      'scheme_not_allowed',
      `scheme "${target.protocol}" is not one of ${policy.allowedSchemes.join(', ')}`,
      target.href,
    );
  }

  const port = target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port);
  if (!policy.allowedPorts.includes(port)) {
    throw new FetchRefused(
      'port_not_allowed',
      `port ${port} is not one of ${policy.allowedPorts.join(', ')}`,
      target.href,
    );
  }
}

export interface ResolvedTarget {
  readonly hostname: string;
  readonly address: string;
  readonly family: 4 | 6;
  /** Every address the resolver returned, all of which were validated. */
  readonly allAddresses: readonly string[];
}

/**
 * Resolves a hostname and validates every address it answers with.
 *
 * One blocked address in the answer refuses the whole fetch. A resolver that
 * returns a public address and a private one is the textbook way to smuggle a
 * connection past a guard that only checks the first.
 */
/**
 * The resolver, as a seam.
 *
 * A multi-address DNS answer and a rebinding answer that changes between two
 * lookups cannot be produced with the host resolver from a test, so the suite
 * substitutes one here. Production never passes this argument, and a test
 * asserts the default is the real resolver.
 */
export type LookupImpl = (hostname: string) => Promise<LookupAddress[]>;

export const systemLookup: LookupImpl = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

export async function resolveAndValidate(
  hostname: string,
  policy: FetchPolicy = FROZEN_POLICY,
  lookupImpl: LookupImpl = systemLookup,
): Promise<ResolvedTarget> {
  let answers: LookupAddress[];
  try {
    answers = await lookupImpl(hostname);
  } catch (error) {
    throw new FetchRefused(
      'dns_failed',
      `could not resolve "${hostname}": ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }

  if (answers.length === 0) {
    throw new FetchRefused('dns_failed', `"${hostname}" resolved to nothing`);
  }

  for (const answer of answers) {
    const verdict = classifyAddress(answer.address);
    if (verdict.allowed) {
      continue;
    }
    // The one deliberate exception, for a local test server. False in the
    // frozen policy.
    const loopbackPermitted =
      policy.permitLoopback &&
      (answer.address === '127.0.0.1' || answer.address === '::1');
    if (!loopbackPermitted) {
      throw new FetchRefused(
        'address_blocked',
        `"${hostname}" resolves to ${verdict.reason ?? answer.address}`,
      );
    }
  }

  const first = answers[0] as LookupAddress;
  return {
    hostname,
    address: first.address,
    family: first.family === 6 ? 6 : 4,
    allAddresses: answers.map((answer) => answer.address),
  };
}

/** An undici agent pinned to one already-validated address. */
function pinnedAgent(target: ResolvedTarget, policy: FetchPolicy): Agent {
  return new Agent({
    connect: {
      // net.connect's lookup contract. Returning only the validated address is
      // what stops a second resolution reaching somewhere else.
      lookup: (
        _hostname: string,
        options: { all?: boolean },
        callback: (
          error: Error | null,
          address: string | LookupAddress[],
          family?: number,
        ) => void,
      ): void => {
        if (options.all === true) {
          callback(null, [{ address: target.address, family: target.family }]);
          return;
        }
        callback(null, target.address, target.family);
      },
    },
    headersTimeout: policy.timeoutMs,
    bodyTimeout: policy.timeoutMs,
    connectTimeout: policy.timeoutMs,
  });
}

function normaliseContentType(raw: string | undefined): string {
  return (raw ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * Throws away a response body we are not going to read.
 *
 * Destroying an undici body emits an 'error' event, and with no listener Node
 * turns that into an unhandled 'error' and takes the process down. The fetcher
 * discards a body on every redirect hop and on every rejected content type, so
 * without this the first PDF anyone served us would have killed the service.
 * Caught by a probe before it ever ran, not in production.
 */
function discardBody(body: { destroy: (error?: Error) => void; on: (event: string, listener: () => void) => void }): void {
  body.on('error', () => undefined);
  body.destroy();
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Fetches one URL, following at most policy.maxRedirects hops and validating
 * every one of them.
 */
export async function guardedFetch(
  initialUrl: string,
  policy: FetchPolicy = FROZEN_POLICY,
  deadlineMs: number = policy.timeoutMs,
  lookupImpl: LookupImpl = systemLookup,
): Promise<FetchOutcome> {
  const startedAt = Date.now();
  const chain: string[] = [];
  let current = new URL(initialUrl);

  for (let hop = 0; hop <= policy.maxRedirects; hop += 1) {
    chain.push(current.href);

    // Every hop, not just the first: scheme, port, DNS, address class.
    assertAllowedUrl(current, policy);
    const target = await resolveAndValidate(current.hostname, policy, lookupImpl);

    const remaining = deadlineMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      throw new FetchRefused('timeout', `exceeded ${deadlineMs}ms before ${current.href}`, current.href);
    }

    const agent = pinnedAgent(target, policy);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);

    try {
      const response = await request(current.href, {
        dispatcher: agent,
        method: 'GET',
        signal: controller.signal,
        headers: {
          'user-agent': policy.userAgent,
          accept: 'text/html, text/plain;q=0.9, */*;q=0.1',
          // Identity, so the byte cap applies to real content and a
          // decompression bomb has nothing to expand into.
          'accept-encoding': 'identity',
        },
      });

      if (REDIRECT_STATUSES.has(response.statusCode)) {
        const location = response.headers.location;
        const locationValue = Array.isArray(location) ? location[0] : location;
        discardBody(response.body);

        if (locationValue === undefined || locationValue === '') {
          throw new FetchRefused(
            'redirect_without_location',
            `${response.statusCode} with no Location at ${current.href}`,
            current.href,
          );
        }
        if (hop === policy.maxRedirects) {
          throw new FetchRefused(
            'too_many_redirects',
            `more than ${policy.maxRedirects} redirects, last at ${current.href}`,
            current.href,
          );
        }
        current = new URL(locationValue, current);
        continue;
      }

      // Content type is judged before a single byte of body is read, so a PDF
      // or an image is rejected and not parsed (§8, §23 case 11).
      const contentType = normaliseContentType(
        Array.isArray(response.headers['content-type'])
          ? response.headers['content-type'][0]
          : response.headers['content-type'],
      );
      if (contentType !== '' && !policy.allowedContentTypes.includes(contentType)) {
        discardBody(response.body);
        throw new FetchRefused(
          'content_type_not_allowed',
          `content-type "${contentType}" is not one of ${policy.allowedContentTypes.join(', ')}`,
          current.href,
        );
      }

      const { body, bytes } = await readCapped(response.body, policy.maxBodyBytes, current.href);

      // An error page's body is dropped here, at the edge, rather than handed
      // up and then not used. A 403 or a 404 body is not evidence and nothing
      // downstream may parse it, so making it unavailable is stronger than
      // asking every caller to remember that. `bytes` is still the real count,
      // which is what a diagnostic row wants.
      const success = response.statusCode >= 200 && response.statusCode < 300;

      return {
        finalUrl: current.href,
        httpStatus: response.statusCode,
        contentType: contentType === '' ? 'text/html' : contentType,
        body: success ? body : '',
        bytes,
        chain,
        truncated: false,
      };
    } catch (error) {
      if (error instanceof FetchRefused) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new FetchRefused('timeout', `timed out after ${deadlineMs}ms`, current.href);
      }
      throw new FetchRefused(
        'transport_error',
        error instanceof Error ? error.message : 'unknown transport error',
        current.href,
      );
    } finally {
      clearTimeout(timer);
      void agent.close().catch(() => undefined);
    }
  }

  throw new FetchRefused('too_many_redirects', `more than ${policy.maxRedirects} redirects`);
}

/**
 * Reads a stream up to a byte budget and gives up the moment it is exceeded.
 *
 * The counter is checked per chunk and the stream destroyed on the chunk that
 * crosses the line, so the peak held in memory is one chunk past the cap — not
 * the whole response.
 */
async function readCapped(
  body: AsyncIterable<Buffer> & {
    destroy: (error?: Error) => void;
    on: (event: string, listener: () => void) => void;
  },
  maxBytes: number,
  url: string,
): Promise<{ body: string; bytes: number }> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of body) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      // Abandoned on the chunk that crosses the line, so the peak held is one
      // chunk past the cap rather than the whole response.
      discardBody(body);
      throw new FetchRefused('body_too_large', `body exceeded ${maxBytes} bytes`, url);
    }
    chunks.push(chunk);
  }

  return { body: Buffer.concat(chunks).toString('utf8'), bytes };
}
