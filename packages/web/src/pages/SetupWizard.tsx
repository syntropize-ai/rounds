import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client.js';
import {
  StepAdmin,
  StepLlm,
  StepDatasources,
  StepNotifications,
  LLM_PROVIDERS,
  STEPS,
} from './setup/index.js';
import type { LlmConfig, NotificationConfig } from './setup/index.js';

// Step progress bar

function ProgressBar({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-4 mb-10">
      {STEPS.map((label, i) => (
        <React.Fragment key={label}>
          <div className="flex flex-col items-center">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                i === current
                  ? 'bg-[var(--color-primary)] text-white ring-4 ring-[var(--color-primary)]/20'
                  : i < current
                    ? 'bg-[var(--color-primary)] text-white'
                    : 'bg-[var(--color-outline-variant)] text-[var(--color-on-surface-variant)]'
              }`}
            >
              {i + 1}
            </div>
            <span
              className={`mt-1.5 text-xs font-medium hidden sm:block ${
                i === current ? 'text-[var(--color-primary)]' : 'text-[var(--color-on-surface-variant)]'
              }`}
            >
              {label}
            </span>
          </div>
          {i < STEPS.length - 1 && (
            <div className={`flex-1 h-0.5 mt-[-16px] ${i < current ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-outline-variant)]'}`} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

// Step 1: Welcome

function StepWelcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="text-center py-8">
      <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-primary text-on-primary-fixed text-4xl mb-6">
        <span role="img" aria-label="radar">
          AI
        </span>
      </div>
      <h1 className="text-3xl font-bold text-on-surface mb-2">Welcome to OpenObs</h1>
      <p className="text-lg text-on-surface-variant font-medium mb-2">An open-source AI SRE</p>
      <p className="text-on-surface-variant max-w-2xl mx-auto mb-10">
        Investigate incidents, build dashboards, tune alerts, and approve remediations from one chat-driven loop. Kubernetes is the first deep workflow; more integrations are on the way.
      </p>
      <p className="text-sm text-on-surface-variant mb-10">Let's get you set up in 2 minutes.</p>
      <button
        type="button"
        onClick={onNext}
        className="px-8 py-3 rounded-xl bg-primary text-on-primary-fixed font-semibold text-base hover:opacity-90 transition-opacity shadow-md"
      >
        Get Started →
      </button>
    </div>
  );
}

// Step 5: Ready

function StepReady({
  llm,
  onFinish,
}: {
  llm: LlmConfig;
  onFinish: () => void;
}) {
  const [completing, setCompleting] = useState(false);

  const handleFinish = async () => {
    // `/api/setup/complete` was deleted in W2 / T2.6 — readiness is now
    // derived from DB state (hasAdmin && hasLLM) via GET /api/setup/status.
    // No server call needed; just exit the wizard.
    setCompleting(true);
    setCompleting(false);
    onFinish();
  };

  const providerLabel = LLM_PROVIDERS.find((p) => p.value === llm.provider)?.label ?? llm.provider;

  return (
    <div className="text-center py-8">
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-secondary/20 text-secondary text-3xl mb-6">
        ✓
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">You're all set!</h2>
      <p className="text-on-surface-variant mb-8">OpenObs is configured and ready to investigate.</p>

      <div className="text-left bg-surface-high rounded-xl border border-outline-variant p-4 mb-8 max-w-md mx-auto space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-on-surface-variant">LLM Provider</span>
          <span className="font-medium text-on-surface">{providerLabel}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-on-surface-variant">Model</span>
          <span className="font-medium text-on-surface">{llm.model}</span>
        </div>
      </div>

      <button
        type="button"
        onClick={() => void handleFinish()}
        disabled={completing}
        className="px-8 py-3 rounded-xl bg-primary text-on-primary-fixed font-semibold text-base hover:opacity-90 disabled:opacity-40 transition-opacity shadow-md"
      >
        {completing ? 'Starting...' : 'Start Investigating →'}
      </button>
    </div>
  );
}

// Main SetupWizard component

export default function SetupWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  // When the server already has a user (upgraded install), the admin step
  // is skipped automatically. `/api/setup/status` returns `hasAdmin`.
  const [adminExists, setAdminExists] = useState<boolean | null>(null);

  const [llm, setLlm] = useState<LlmConfig>({
    provider: 'anthropic',
    apiKey: '',
    model: '',
    baseUrl: '',
    region: '',
    authType: 'api-key',
    apiKeyHelper: '',
    apiFormat: 'anthropic',
  });

  const [notifications, setNotifications] = useState<NotificationConfig>({
    slackWebhook: '',
    pagerDutyKey: '',
    emailHost: '',
    emailPort: '587',
    emailUser: '',
    emailPass: '',
    emailFrom: '',
  });

  useEffect(() => {
    void apiClient
      .get<{ hasAdmin?: boolean }>('/setup/status')
      .then((res) => {
        if (!res.error) setAdminExists(!!res.data.hasAdmin);
        else setAdminExists(false);
      })
      .catch(() => setAdminExists(false));
  }, []);

  // Once an admin exists, `POST /api/setup/admin` is locked (returns 409).
  // Back-navigating into the Admin step would strand the user on a form
  // that can't be submitted, so we skip it: any Back attempt that would
  // land on step 1 jumps past it instead.
  const ADMIN_STEP = 1;

  const next = () => setStep((s) => s + 1);
  const back = () => setStep((s) => {
    const target = s - 1;
    // Skip past Admin when an admin already exists.
    if (adminExists && target === ADMIN_STEP) return ADMIN_STEP - 1;
    return Math.max(target, 0);
  });

  return (
    <div className="setup-theme-light min-h-screen bg-surface flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-3xl bg-surface-low border border-outline-variant rounded-2xl p-8">
        <ProgressBar current={step} />

        {step === 0 && <StepWelcome onNext={next} />}
        {step === 1 && (
          adminExists ? (
            <div className="py-8 text-center">
              <p className="text-on-surface-variant text-sm mb-4">
                Administrator already configured — skipping this step.
              </p>
              <button
                type="button"
                onClick={next}
                className="px-6 py-2 rounded-lg bg-primary text-on-primary-fixed font-semibold text-sm hover:opacity-90 transition-opacity"
              >
                Continue →
              </button>
            </div>
          ) : (
            <StepAdmin
              onComplete={() => {
                // Admin just created — mark it so Back from the next step
                // skips past the now-locked Admin form. See `back()` above.
                setAdminExists(true);
                next();
              }}
              onBack={back}
            />
          )
        )}
        {step === 2 && (
          <StepLlm
            config={llm}
            onChange={(c) => setLlm((prev) => ({ ...prev, ...c }))}
            onNext={next}
            onBack={back}
          />
        )}
        {step === 3 && <StepDatasources onNext={next} onBack={back} />}
        {step === 4 && (
          <StepNotifications
            config={notifications}
            onChange={(c) => setNotifications((prev) => ({ ...prev, ...c }))}
            onNext={next}
            onBack={back}
          />
        )}
        {step === 5 && (
          <StepReady
            llm={llm}
            onFinish={() => navigate('/')}
          />
        )}
      </div>
    </div>
  );
}
