/**
 * The provider seam (SPEC.md §1, §22).
 *
 * §1 freezes "one runtime provider, chosen by eval on Day 6". The thing worth
 * testing on Day 4 is therefore the refusal: that nothing here quietly becomes
 * the production provider before that evaluation has happened.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearProviders,
  getProvider,
  registerProvider,
  registeredProviders,
  resolveProvider,
  type ModelProvider,
} from '../../src/ai/provider';
import { registerAvailableProviders } from '../../src/ai/providers';
import { OFFLINE_PROVIDER_ID, offlineProvider } from '../../src/ai/providers/offline';

afterEach(() => {
  clearProviders();
});

describe('no provider is chosen by default (§1, §22)', () => {
  it('refuses to resolve when MODEL_PROVIDER is unset', () => {
    registerAvailableProviders();
    for (const value of [undefined, '']) {
      expect(() => resolveProvider(value)).toThrow(/MODEL_PROVIDER is not set/);
    }
  });

  it('does not pick the only registered provider', () => {
    registerProvider(offlineProvider);
    expect(registeredProviders()).toStrictEqual([OFFLINE_PROVIDER_ID]);
    // One candidate is still not a decision.
    expect(() => resolveProvider(undefined)).toThrow(/Day 6/);
  });

  it('names the Day 6 evaluation in the refusal, so the reason is on screen', () => {
    expect(() => resolveProvider(undefined)).toThrow(/§22/);
  });

  it('refuses an id that is not registered, and says what is', () => {
    registerProvider(offlineProvider);
    expect(() => getProvider('some-vendor')).toThrow(/Registered: offline/);
  });

  it('resolves the configured id when it exists', () => {
    registerAvailableProviders();
    expect(resolveProvider(OFFLINE_PROVIDER_ID).id).toBe(OFFLINE_PROVIDER_ID);
  });
});

describe('registration is separate from selection', () => {
  it('is idempotent, so a worker boot and a test can both call it', () => {
    registerAvailableProviders();
    registerAvailableProviders();
    expect(registeredProviders()).toStrictEqual([OFFLINE_PROVIDER_ID]);
  });

  it('refuses two providers under one id', () => {
    registerProvider(offlineProvider);
    expect(() => registerProvider({ ...offlineProvider })).toThrow(/already registered/);
  });

  it('ships exactly one adapter today, and it is not billable', () => {
    registerAvailableProviders();
    const providers = registeredProviders().map((id) => getProvider(id));
    expect(providers).toHaveLength(1);
    for (const provider of providers) {
      expect(provider.billable).toBe(false);
    }
  });

  it('declares whether an adapter spends money, so the handler can refuse it', () => {
    const vendor: ModelProvider = { ...offlineProvider, id: 'vendor', billable: true };
    expect(vendor.billable).toBe(true);
  });
});
