/**
 * The application root.
 *
 * The approval queue is Day 8 (§13). Until then this page exists so the web
 * container has a route that proves it booted, and says where the health
 * endpoint is. It is reachable over Tailscale only (§20).
 */
export default function Home() {
  return (
    <main style={{ padding: '2rem', maxWidth: '42rem' }}>
      <h1 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>STENTH Operator</h1>
      <p style={{ margin: 0, color: '#555' }}>
        V1.1. Private surface — reachable over Tailscale only. Health:{' '}
        <a href="/api/health">/api/health</a>
      </p>
    </main>
  );
}
