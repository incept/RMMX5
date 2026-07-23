'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

const EVENT_LABELS: Record<string, { title: string; hint: string; vars: string }> = {
  link_status_change: {
    title: 'Link status change',
    hint: 'Fires when a tracked link flips Live / Requested / Removed (e.g. "your link was removed").',
    vars: '{{name}} {{link}} {{link_status}}',
  },
  status_change: {
    title: 'CRM status change',
    hint: "Fires when a contact's status changes.",
    vars: '{{name}} {{status}}',
  },
  client_countdown: {
    title: 'Client countdown',
    hint: 'Fires when a client has N days left in their service period (checked by the cron tick).',
    vars: '{{name}} {{days_left}}',
  },
};

/** Admin: configurable email/SMS notifications for clients. */
export default function NotificationsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [rules, setRules] = useState<any[]>([]);
  const [log, setLog] = useState<any[]>([]);

  const load = useCallback(async () => {
    const [r, l] = await Promise.all([
      supabase.from('notification_rules').select('*').order('event'),
      supabase
        .from('notifications_log')
        .select('*, contacts ( name )')
        .order('created_at', { ascending: false })
        .limit(25),
    ]);
    setRules(r.data ?? []);
    setLog(l.data ?? []);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  async function update(id: string, patch: Record<string, any>) {
    const { error } = await supabase.from('notification_rules').update(patch).eq('id', id);
    if (error) alert(error.message);
    load();
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-lg font-semibold">Notifications</h1>

      {rules.map((rule) => {
        const meta = EVENT_LABELS[rule.event] ?? { title: rule.event, hint: '', vars: '' };
        return (
          <div key={rule.id} className="card">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold">{meta.title}</h2>
                <p className="mt-0.5 text-xs text-gray-400">{meta.hint}</p>
              </div>
              <button
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  rule.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                }`}
                onClick={() => update(rule.id, { enabled: !rule.enabled })}
              >
                {rule.enabled ? 'Enabled' : 'Disabled'}
              </button>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                {['email', 'sms'].map((channel) => (
                  <label key={channel} className="flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      checked={(rule.channels ?? []).includes(channel)}
                      onChange={(e) => {
                        const channels = e.target.checked
                          ? [...(rule.channels ?? []), channel]
                          : (rule.channels ?? []).filter((c: string) => c !== channel);
                        update(rule.id, { channels });
                      }}
                    />
                    {channel.toUpperCase()}
                  </label>
                ))}
              </div>
              <label className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={!!rule.clients_only}
                  onChange={(e) => update(rule.id, { clients_only: e.target.checked })}
                />
                Clients only
              </label>
              {rule.event === 'client_countdown' && (
                <label className="flex items-center gap-1 text-sm">
                  Days-before thresholds:
                  <input
                    className="input w-28 py-1"
                    defaultValue={(rule.config?.days_before ?? [7, 1]).join(', ')}
                    onBlur={(e) =>
                      update(rule.id, {
                        config: {
                          ...rule.config,
                          days_before: e.target.value
                            .split(',')
                            .map((s) => Number(s.trim()))
                            .filter((n) => !isNaN(n)),
                        },
                      })
                    }
                  />
                </label>
              )}
            </div>

            <div className="mt-3">
              <label className="label">
                Message template <span className="lowercase">(placeholders: {meta.vars})</span>
              </label>
              <textarea
                className="input min-h-16"
                defaultValue={rule.template}
                onBlur={(e) => e.target.value !== rule.template && update(rule.id, { template: e.target.value })}
              />
            </div>
          </div>
        );
      })}

      <div className="card">
        <h2 className="mb-2 text-sm font-semibold">Recent notifications</h2>
        <div className="space-y-1.5">
          {log.map((entry) => (
            <div key={entry.id} className="flex gap-3 text-sm">
              <span className="w-32 shrink-0 text-xs text-gray-400">
                {new Date(entry.created_at).toLocaleString()}
              </span>
              <span className="w-14 shrink-0 text-xs uppercase">{entry.channel}</span>
              <span className="w-24 shrink-0 truncate text-xs font-medium">
                {entry.contacts?.name}
              </span>
              <span className={`flex-1 truncate ${entry.status === 'failed' ? 'text-red-600' : ''}`}>
                {entry.message}
                {entry.error ? ` — ${entry.error}` : ''}
              </span>
            </div>
          ))}
          {log.length === 0 && <div className="text-sm text-gray-400">Nothing sent yet.</div>}
        </div>
      </div>
    </div>
  );
}
