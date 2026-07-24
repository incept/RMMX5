'use client';

import { useCallback, useEffect, useState } from 'react';

interface SectionField {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
}

const SECTIONS: { key: string; title: string; hint: string; fields: SectionField[] }[] = [
  {
    key: 'brightdata',
    title: 'BrightData',
    hint: 'SERP zone powers the automatic Google search on lead intake and the manual "Run Google search". The proxy zone is your backconnect rotating proxy for manual web searches outside the app.',
    fields: [
      { key: 'api_key', label: 'API key', secret: true },
      { key: 'serp_zone', label: 'SERP zone name', placeholder: 'serp_api1' },
      { key: 'proxy_zone', label: 'Proxy zone name (rotating/backconnect)', placeholder: 'residential_proxy1' },
      { key: 'proxy_username', label: 'Proxy username', placeholder: 'brd-customer-XXXX-zone-YYYY' },
      { key: 'proxy_password', label: 'Proxy password', secret: true },
    ],
  },
  {
    key: 'emailit',
    title: 'Emailit',
    hint: 'Fallback email sender, client notifications, and signed bounce/complaint events.',
    fields: [
      { key: 'api_key', label: 'API key', secret: true },
      { key: 'from_address', label: 'From address', placeholder: 'alerts@yourdomain.com' },
      { key: 'from_name', label: 'From name', placeholder: 'RMMX5' },
      { key: 'webhook_signing_secret', label: 'Webhook signing secret', secret: true, placeholder: 'whsec_…' },
    ],
  },
  {
    key: 'textlink',
    title: 'TextLink SMS',
    hint: 'SMS campaigns and SMS notifications. Requires a paired Android device with an active SIM in your TextLink dashboard.',
    fields: [
      { key: 'api_key', label: 'API key', secret: true },
      { key: 'sim_card_id', label: 'SIM card / device ID (optional)' },
    ],
  },
  {
    key: 'stripe',
    title: 'Stripe',
    hint: 'Read-only revenue reporting on the dashboard. Use a restricted key with read access to Balance Transactions.',
    fields: [{ key: 'secret_key', label: 'Secret key', secret: true }],
  },
  {
    key: 'fluent_forms',
    title: 'Fluent Forms',
    hint: 'Secret sent in the Authorization header by the Fluent Forms webhook feed.',
    fields: [{ key: 'webhook_secret', label: 'Webhook secret', secret: true }],
  },
  {
    key: 'callscaler',
    title: 'CallScaler',
    hint: 'Call tracking. The post-call webhook turns inbound calls into contacts (or attaches them to existing ones by phone/gclid); the API key lets the cron tick backfill any calls the webhook missed.',
    fields: [
      { key: 'api_key', label: 'API key', secret: true, placeholder: 'cs_key_…' },
      { key: 'webhook_secret', label: 'Webhook secret', secret: true },
    ],
  },
  {
    key: 'inbound_email',
    title: 'Inbound email webhook',
    hint: 'A separate bearer secret for the inbound-mail forwarder or relay.',
    fields: [{ key: 'webhook_secret', label: 'Webhook secret', secret: true }],
  },
  {
    key: 'voicemail',
    title: 'Voicemail provider',
    hint: 'Any ringless-voicemail provider that accepts JSON POST { phone, audio_url, caller_id } with a Bearer key.',
    fields: [
      { key: 'provider_url', label: 'Provider endpoint URL', placeholder: 'https://api.dropcowboy.com/...' },
      { key: 'api_key', label: 'API key', secret: true },
      { key: 'caller_id', label: 'Caller ID number' },
    ],
  },
  {
    key: 'ipapi',
    title: 'ip-api.com geolocation',
    hint: 'Resolves a lead’s IP to a city/state so the automatic Google search can narrow by location when the form did not collect one. Works with no key on the free tier (HTTP, ~45 lookups/minute); a paid key switches to the HTTPS pro endpoint with no rate limit.',
    fields: [{ key: 'api_key', label: 'API key (optional — blank uses the free tier)', secret: true }],
  },
  {
    key: 'search',
    title: 'Auto-search settings',
    hint: 'Tuning for the automatic Google search that runs on lead import.',
    fields: [
      { key: 'country', label: 'Country code', placeholder: 'us' },
      { key: 'num_results', label: 'Results to fetch', placeholder: '20' },
      { key: 'extra_terms', label: 'Extra search terms', placeholder: 'arrest OR complaint OR review' },
    ],
  },
  {
    key: 'defaults',
    title: 'Defaults',
    hint: 'App-wide defaults.',
    fields: [{ key: 'service_days', label: 'Default client service period (days)', placeholder: '90' }],
  },
];

/** Admin: API keys & app configuration (stored in the settings table, admin-only). */
export default function IntegrationsPage() {
  const [settings, setSettings] = useState<Record<string, Record<string, any>>>({});
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [origin, setOrigin] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/settings');
    if (res.ok) setSettings((await res.json()).settings ?? {});
  }, []);

  useEffect(() => {
    load();
    setOrigin(window.location.origin);
  }, [load]);

  async function save(key: string) {
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value: settings[key] ?? {} }),
    });
    if (res.ok) {
      setSavedKey(key);
      setTimeout(() => setSavedKey(null), 1500);
    } else alert((await res.json()).error ?? 'Save failed');
  }

  const brightdata = settings.brightdata ?? {};

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">Integrations & APIs</h1>
      <p className="text-xs text-gray-400">
        Keys are stored in the database with admin-only access and are only ever read server-side —
        they never reach the browser of non-admin users.
      </p>

      {SECTIONS.map((section) => (
        <div key={section.key} className="card">
          <h2 className="text-sm font-semibold">{section.title}</h2>
          <p className="mt-0.5 mb-3 text-xs text-gray-400">{section.hint}</p>
          <div className="grid grid-cols-2 gap-2">
            {section.fields.map((field) => (
              <div key={field.key} className={section.fields.length === 1 ? 'col-span-2' : ''}>
                <label className="label">{field.label}</label>
                <input
                  className="input"
                  type={field.secret ? 'password' : 'text'}
                  placeholder={field.placeholder}
                  value={settings[section.key]?.[field.key] ?? ''}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      [section.key]: { ...(s[section.key] ?? {}), [field.key]: e.target.value },
                    }))
                  }
                />
              </div>
            ))}
          </div>
          <button className="btn btn-primary mt-3 py-1" onClick={() => save(section.key)}>
            {savedKey === section.key ? '✓ Saved' : 'Save'}
          </button>

          {section.key === 'fluent_forms' && (
            <div className="mt-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
              <div className="mb-1 font-semibold">Fluent Forms webhook</div>
              <div className="space-y-1 font-mono">
                <div>URL: {origin}/api/webhooks/fluent-forms</div>
                <div>Header: Authorization: Bearer &lt;webhook_secret&gt;</div>
              </div>
              <div className="mt-2">
                Cron: <span className="font-mono">{origin}/api/cron/tick</span> with
                <span className="font-mono"> Authorization: Bearer &lt;CRON_SECRET&gt;</span>
              </div>
            </div>
          )}

          {section.key === 'callscaler' && (
            <div className="mt-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
              <div className="mb-1 font-semibold">
                Post-call webhook — in each call flow: AUTOMATIONS → Webhook
              </div>
              <div className="space-y-1 font-mono">
                <div>URL: {origin}/api/webhooks/callscaler</div>
                <div>Custom header — name: x-rmmx-webhook-secret</div>
                <div>Custom header — value: &lt;webhook_secret&gt; (the secret alone)</div>
              </div>
              <div className="mt-2">
                Use the <span className="font-semibold">x-rmmx-webhook-secret</span> header, not
                Authorization — CallScaler strips the Authorization header, so the call arrives
                unauthenticated and is rejected.
              </div>
              <div className="mt-2">
                Set the webhook mode to <span className="font-semibold">“Wait for AI”</span> so the
                spam screen and transcript arrive in the same event — immediate mode sends the AI
                fields as null, and spam calls would then create contacts.
              </div>
            </div>
          )}

          {section.key === 'inbound_email' && (
            <div className="mt-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
              <div className="font-mono">URL: {origin}/api/webhooks/inbound-email</div>
              <div className="font-mono">
                Header: Authorization: Bearer &lt;webhook_secret&gt;
              </div>
            </div>
          )}

          {section.key === 'emailit' && (
            <div className="mt-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
              <div className="font-mono">URL: {origin}/api/webhooks/emailit</div>
              <div className="mt-1">
                Emailit supplies X-Emailit-Signature and X-Emailit-Timestamp automatically.
              </div>
            </div>
          )}

          {section.key === 'brightdata' && (
            <div className="mt-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
              SERP requests this month (Google + Bing, all searches):{' '}
              <span className="font-mono font-semibold">
                {settings.usage?.serp?.[new Date().toISOString().slice(0, 7)] ?? 0}
              </span>
            </div>
          )}

          {section.key === 'brightdata' && brightdata.proxy_zone && (
            <div className="mt-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
              <div className="mb-1 font-semibold">
                Backconnect rotating proxy — use in your browser/proxy manager for manual searches:
              </div>
              <div className="font-mono">
                host brd.superproxy.io · port 33335 · user {brightdata.proxy_username || '<username>'} · pass ••••
              </div>
              <div className="mt-1">Each request rotates to a fresh residential IP automatically.</div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
