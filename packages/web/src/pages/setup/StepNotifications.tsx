import React, { useState } from 'react';
import { apiClient } from '../../api/client.js';
import type { NotificationConfig } from './types.js';

export function StepNotifications({
  config,
  onChange,
  onNext,
  onBack,
}: {
  config: NotificationConfig;
  onChange: (c: Partial<NotificationConfig>) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const [saving, setSaving] = useState(false);

  const handleNext = async () => {
    setSaving(true);
    const notifications: Record<string, unknown> = {};
    if (config.slackWebhook) notifications['slack'] = { webhookUrl: config.slackWebhook };
    if (config.pagerDutyKey) notifications['pagerduty'] = { integrationKey: config.pagerDutyKey };
    if (config.emailHost) {
      notifications['email'] = {
        host: config.emailHost,
        port: Number.parseInt(config.emailPort || '587', 10),
        username: config.emailUser,
        password: config.emailPass,
        from: config.emailFrom,
      };
    }

    if (Object.keys(notifications).length > 0) {
      // PUT /api/system/notifications replaces the legacy POST /setup/notifications.
      // Bootstrap-aware middleware lets the wizard reach it pre-admin.
      await apiClient.put('/system/notifications', notifications);
    }
    setSaving(false);
    onNext();
  };

  return (
    <div>
      <h2 className="text-xl font-bold text-[var(--color-on-surface)] mb-1">Notifications</h2>
      <p className="text-[var(--color-on-surface-variant)] text-sm mb-6">
        Get alerted when incidents are detected. All optional - skip if not needed now.
      </p>

      <div className="space-y-4">
        <div className="p-4 rounded-xl border border-[var(--color-outline-variant)] bg-[var(--color-surface-highest)]">
          <h3 className="text-sm font-semibold text-[var(--color-on-surface)] mb-3">Slack</h3>
          <label className="block text-xs font-medium text-[var(--color-on-surface-variant)] mb-1">Webhook URL</label>
          <input
            type="url"
            value={config.slackWebhook}
            onChange={(e) => onChange({ slackWebhook: e.target.value })}
            placeholder="https://hooks.slack.com/services/..."
            className="w-full px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-high)] text-[var(--color-on-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
          />
        </div>

        <div className="p-4 rounded-xl border border-[var(--color-outline-variant)] bg-[var(--color-surface-highest)]">
          <h3 className="text-sm font-semibold text-[var(--color-on-surface)] mb-3">PagerDuty</h3>
          <label className="block text-xs font-medium text-[var(--color-on-surface-variant)] mb-1">Integration Key</label>
          <input
            type="password"
            value={config.pagerDutyKey}
            onChange={(e) => onChange({ pagerDutyKey: e.target.value })}
            placeholder="your-integration-key"
            className="w-full px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-high)] text-[var(--color-on-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
          />
        </div>

        <div className="p-4 rounded-xl border border-[var(--color-outline-variant)] bg-[var(--color-surface-highest)]">
          <h3 className="text-sm font-semibold text-[var(--color-on-surface)] mb-3">Email (SMTP)</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--color-on-surface-variant)] mb-1">SMTP Host</label>
              <input
                type="text"
                value={config.emailHost}
                onChange={(e) => onChange({ emailHost: e.target.value })}
                placeholder="smtp.example.com"
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-high)] text-[var(--color-on-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--color-on-surface-variant)] mb-1">Port</label>
              <input
                type="number"
                value={config.emailPort}
                onChange={(e) => onChange({ emailPort: e.target.value })}
                placeholder="587"
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-high)] text-[var(--color-on-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--color-on-surface-variant)] mb-1">Username</label>
              <input
                type="text"
                value={config.emailUser}
                onChange={(e) => onChange({ emailUser: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-high)] text-[var(--color-on-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--color-on-surface-variant)] mb-1">Password</label>
              <input
                type="text"
                value={config.emailPass}
                onChange={(e) => onChange({ emailPass: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-high)] text-[var(--color-on-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-[var(--color-on-surface-variant)] mb-1">From address</label>
              <input
                type="email"
                value={config.emailFrom}
                onChange={(e) => onChange({ emailFrom: e.target.value })}
                placeholder="alerts@example.com"
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-high)] text-[var(--color-on-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
              />
            </div>
          </div>
        </div>

        <div className="flex justify-between mt-6">
          <button type="button" onClick={onBack} className="px-5 py-2 text-sm font-medium text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)]">
            ← Back
          </button>
          <div className="flex gap-3">
            <button type="button" onClick={onNext} className="px-5 py-2 text-sm text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)]">
              Skip for now
            </button>
            <button
              type="button"
              onClick={() => void handleNext()}
              disabled={saving}
              className="px-6 py-2 rounded-lg bg-primary text-on-primary-fixed text-sm font-semibold hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              {saving ? 'Saving...' : 'Continue →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
