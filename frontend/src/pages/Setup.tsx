import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { setupApi, LLMConfig, DatasourceConfig, LLMProvider, DatasourceType } from '@/api/setup'

// ─── Step indicator ──────────────────────────────────────────────────────────

const STEPS = ['LLM', 'Data Sources', 'Notifications', 'Done']

function StepIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-2">
      {STEPS.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <div className="flex items-center gap-2">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                i < current
                  ? 'bg-primary text-black'
                  : i === current
                  ? 'bg-primary/20 text-primary border border-primary'
                  : 'bg-surface-high text-on-surface-variant'
              }`}
            >
              {i < current ? (
                <span className="material-symbols-rounded text-sm">check</span>
              ) : (
                i + 1
              )}
            </div>
            <span
              className={`text-sm hidden sm:block ${
                i === current ? 'text-on-surface font-medium' : 'text-on-surface-variant'
              }`}
            >
              {label}
            </span>
          </div>
          {i < STEPS.length - 1 && (
            <div className={`w-8 h-px ${i < current ? 'bg-primary' : 'bg-outline/30'}`} />
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Shared UI primitives ─────────────────────────────────────────────────────

function FormGroup({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-on-surface-variant">{label}</label>
      {children}
      {hint && <p className="text-xs text-on-surface-variant/60">{hint}</p>}
    </div>
  )
}

function Input({
  type = 'text',
  placeholder,
  value,
  onChange,
}: {
  type?: string
  placeholder?: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full bg-surface-high border border-outline/30 rounded-xl px-4 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/50 outline-none focus:border-primary/60 transition-all"
    />
  )
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-surface-high border border-outline/30 rounded-xl px-4 py-2.5 text-sm text-on-surface outline-none focus:border-primary/60 transition-all appearance-none"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-surface-high">
          {o.label}
        </option>
      ))}
    </select>
  )
}

function StatusBadge({ status, message }: { status: 'idle' | 'testing' | 'ok' | 'error'; message?: string }) {
  if (status === 'idle') return null
  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm mt-2 ${
        status === 'testing'
          ? 'bg-primary/10 text-primary'
          : status === 'ok'
          ? 'bg-secondary/10 text-secondary'
          : 'bg-error/10 text-error'
      }`}
    >
      <span className="material-symbols-rounded text-base">
        {status === 'testing' ? 'progress_activity' : status === 'ok' ? 'check_circle' : 'error'}
      </span>
      {message || (status === 'testing' ? 'Testing connection...' : status === 'ok' ? 'Connected!' : 'Connection failed')}
    </div>
  )
}

// ─── Step 1: LLM ─────────────────────────────────────────────────────────────

const LLM_PROVIDERS: { value: LLMProvider; label: string; models: string[] }[] = [
  {
    value: 'anthropic',
    label: 'Anthropic (Claude)',
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  },
  {
    value: 'openai',
    label: 'OpenAI',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  },
  {
    value: 'azure-openai',
    label: 'Azure OpenAI',
    models: ['gpt-4o', 'gpt-4-turbo'],
  },
  {
    value: 'aws-bedrock',
    label: 'AWS Bedrock',
    models: ['anthropic.claude-3-5-sonnet-20241022-v2:0', 'anthropic.claude-3-haiku-20240307-v1:0'],
  },
  {
    value: 'corporate-gateway',
    label: 'Corporate LLM Gateway',
    models: ['auto'],
  },
  {
    value: 'gemini',
    label: 'Google Gemini',
    models: ['gemini-3-flash-preview', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  },
  {
    value: 'ollama',
    label: 'Ollama (Local)',
    models: ['llama3.2', 'llama3.1', 'mistral', 'qwen2.5', 'gemma2', 'phi4', 'deepseek-r1'],
  },
]

function StepLLM({ onNext }: { onNext: () => void }) {
  const [provider, setProvider] = useState<LLMProvider>('anthropic')
  const [model, setModel] = useState('claude-sonnet-4-6')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [awsRegion, setAwsRegion] = useState('us-east-1')
  const [awsKeyId, setAwsKeyId] = useState('')
  const [awsSecret, setAwsSecret] = useState('')
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle')
  const [testMsg, setTestMsg] = useState('')
  const [saving, setSaving] = useState(false)
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [ollamaFetching, setOllamaFetching] = useState(false)
  const fetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const selectedProvider = LLM_PROVIDERS.find((p) => p.value === provider)!

  // Fetch Ollama models when base URL changes (debounced)
  useEffect(() => {
    if (provider !== 'ollama' || !baseUrl) return
    if (fetchTimer.current) clearTimeout(fetchTimer.current)
    fetchTimer.current = setTimeout(async () => {
      setOllamaFetching(true)
      try {
        const res = await fetch(`/api/setup/ollama/models?baseUrl=${encodeURIComponent(baseUrl)}`)
        const data = await res.json()
        if (data.ok && data.models?.length > 0) {
          const names = data.models.map((m: { name: string }) => m.name)
          setOllamaModels(names)
          if (!names.includes(model)) setModel(names[0])
        } else {
          setOllamaModels([])
        }
      } catch {
        setOllamaModels([])
      } finally {
        setOllamaFetching(false)
      }
    }, 600)
    return () => { if (fetchTimer.current) clearTimeout(fetchTimer.current) }
  }, [provider, baseUrl])

  function handleProviderChange(v: string) {
    setProvider(v as LLMProvider)
    setModel(LLM_PROVIDERS.find((p) => p.value === v)!.models[0])
    setOllamaModels([])
    setTestStatus('idle')
    if (v === 'ollama') setBaseUrl('http://localhost:11434')
    else if (baseUrl === 'http://localhost:11434') setBaseUrl('')
  }

  async function handleTest() {
    setTestStatus('testing')
    setTestMsg('')
    try {
      const config = buildConfig()
      const res = await setupApi.testLLM(config)
      if (res.ok) {
        setTestStatus('ok')
        setTestMsg(`Connected! ${res.latencyMs ? `(${res.latencyMs}ms)` : ''}`)
      } else {
        setTestStatus('error')
        setTestMsg(res.error ?? 'Connection failed')
      }
    } catch (e: any) {
      setTestStatus('error')
      setTestMsg(e.message ?? 'Connection failed')
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      await setupApi.configureLLM(buildConfig())
      onNext()
    } catch (e: any) {
      setTestStatus('error')
      setTestMsg(e.message ?? 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  function buildConfig(): LLMConfig {
    const base: LLMConfig = { provider, model }
    if (provider === 'anthropic' || provider === 'openai' || provider === 'gemini') base.apiKey = apiKey
    if (provider === 'azure-openai' || provider === 'corporate-gateway') {
      base.apiKey = apiKey
      base.baseUrl = baseUrl
    }
    if (provider === 'ollama') base.baseUrl = baseUrl
    if (provider === 'aws-bedrock') {
      base.awsRegion = awsRegion
      base.awsAccessKeyId = awsKeyId
      base.awsSecretAccessKey = awsSecret
    }
    return base
  }

  const canTest =
    (provider === 'anthropic' || provider === 'openai' || provider === 'gemini') ? apiKey.length > 10 :
    provider === 'azure-openai' ? apiKey.length > 0 && baseUrl.length > 0 :
    provider === 'aws-bedrock' ? awsKeyId.length > 0 && awsSecret.length > 0 :
    provider === 'corporate-gateway' ? baseUrl.length > 0 :
    provider === 'ollama' ? baseUrl.length > 0 :
    false

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display font-bold text-xl mb-1">Connect your AI engine</h2>
        <p className="text-on-surface-variant text-sm">
          Curator uses an LLM to generate dashboards, investigate incidents, and create alert rules.
        </p>
      </div>

      <FormGroup label="Provider">
        <Select
          value={provider}
          onChange={handleProviderChange}
          options={LLM_PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
        />
      </FormGroup>

      {provider === 'ollama' && (
        <FormGroup label="Ollama Base URL" hint="The URL where Ollama is running.">
          <div className="flex gap-2">
            <Input placeholder="http://localhost:11434" value={baseUrl} onChange={setBaseUrl} />
            <button
              type="button"
              title="Refresh model list"
              className="flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-xl border border-outline/40 text-on-surface-variant hover:bg-surface-high hover:text-on-surface transition-all"
              onClick={() => {
                const cur = baseUrl.trim()
                setBaseUrl(cur + ' ')
                setTimeout(() => setBaseUrl(cur), 50)
              }}
            >
              <span className={`material-symbols-rounded text-base ${ollamaFetching ? 'animate-spin' : ''}`}>
                refresh
              </span>
            </button>
          </div>
        </FormGroup>
      )}

      <FormGroup label="Model">
        {provider === 'ollama' ? (
          ollamaModels.length > 0 ? (
            <Select
              value={model}
              onChange={setModel}
              options={ollamaModels.map((m) => ({ value: m, label: m }))}
            />
          ) : (
            <div className="relative">
              <Input
                placeholder={ollamaFetching ? 'Loading models...' : 'e.g. llama3.2, mistral, qwen2.5'}
                value={model}
                onChange={setModel}
              />
              {ollamaFetching && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-xs animate-pulse">
                  fetching...
                </span>
              )}
            </div>
          )
        ) : (
          <Select
            value={model}
            onChange={setModel}
            options={selectedProvider.models.map((m) => ({ value: m, label: m }))}
          />
        )}
      </FormGroup>

      {(provider === 'anthropic' || provider === 'openai' || provider === 'azure-openai' || provider === 'gemini') && (
        <FormGroup label="API Key" hint="Your key is stored locally and never sent to Anthropic servers.">
          <Input
            type="password"
            placeholder={provider === 'anthropic' ? 'sk-ant-...' : provider === 'gemini' ? 'AIza...' : 'sk-...'}
            value={apiKey}
            onChange={setApiKey}
          />
        </FormGroup>
      )}

      {(provider === 'azure-openai' || provider === 'corporate-gateway') && (
        <FormGroup label="Base URL" hint="e.g. https://your-resource.openai.azure.com">
          <Input placeholder="https://" value={baseUrl} onChange={setBaseUrl} />
        </FormGroup>
      )}

      {provider === 'aws-bedrock' && (
        <>
          <FormGroup label="AWS Region">
            <Input placeholder="us-east-1" value={awsRegion} onChange={setAwsRegion} />
          </FormGroup>
          <FormGroup label="Access Key ID">
            <Input placeholder="AKIA..." value={awsKeyId} onChange={setAwsKeyId} />
          </FormGroup>
          <FormGroup label="Secret Access Key">
            <Input type="password" placeholder="••••••••" value={awsSecret} onChange={setAwsSecret} />
          </FormGroup>
        </>
      )}

      <StatusBadge status={testStatus} message={testMsg} />

      <div className="flex gap-3 pt-2">
        <button
          onClick={handleTest}
          disabled={!canTest || testStatus === 'testing'}
          className="flex items-center gap-2 px-4 py-2 rounded-xl border border-outline/40 text-sm text-on-surface-variant hover:bg-surface-high hover:text-on-surface transition-all disabled:opacity-40"
        >
          <span className="material-symbols-rounded text-base">wifi_tethering</span>
          Test connection
        </button>
        <button
          onClick={handleSave}
          disabled={!canTest || saving}
          className="flex-1 gradient-primary rounded-xl py-2 text-sm font-medium text-black disabled:opacity-40"
        >
          {saving ? 'Saving...' : 'Save & Continue →'}
        </button>
      </div>
    </div>
  )
}

// ─── Step 2: Datasources ──────────────────────────────────────────────────────

const DS_TYPES: { value: DatasourceType; label: string; placeholder: string }[] = [
  { value: 'prometheus', label: 'Prometheus', placeholder: 'http://localhost:9090' },
  { value: 'victoria-metrics', label: 'VictoriaMetrics', placeholder: 'http://localhost:8428' },
  { value: 'loki', label: 'Loki (logs)', placeholder: 'http://localhost:3100' },
  { value: 'tempo', label: 'Tempo (traces)', placeholder: 'http://localhost:3200' },
  { value: 'jaeger', label: 'Jaeger (traces)', placeholder: 'http://localhost:16686' },
  { value: 'elasticsearch', label: 'Elasticsearch', placeholder: 'http://localhost:9200' },
]

interface AddedDatasource extends DatasourceConfig {
  tested: boolean
}

function DatasourceForm({
  onAdd,
}: {
  onAdd: (ds: AddedDatasource) => void
}) {
  const [type, setType] = useState<DatasourceType>('prometheus')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [env, setEnv] = useState('production')
  const [authType, setAuthType] = useState<'none' | 'basic' | 'bearer'>('none')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle')
  const [testMsg, setTestMsg] = useState('')

  const dsType = DS_TYPES.find((d) => d.value === type)!
  const canTest = url.trim().length > 0

  function buildDs(): DatasourceConfig {
    return {
      name: name || `${dsType.label} (${env})`,
      type,
      url: url.trim(),
      environment: env,
      isDefault: true,
      auth:
        authType === 'none'
          ? { type: 'none' }
          : authType === 'basic'
          ? { type: 'basic', username, password }
          : { type: 'bearer', token },
    }
  }

  async function handleTest() {
    setTestStatus('testing')
    setTestMsg('')
    try {
      const res = await setupApi.testDatasource(buildDs())
      if (res.ok) {
        setTestStatus('ok')
        setTestMsg(`Connected! ${res.latencyMs ? `(${res.latencyMs}ms)` : ''}`)
      } else {
        setTestStatus('error')
        setTestMsg(res.error ?? 'Connection failed')
      }
    } catch (e: any) {
      setTestStatus('error')
      setTestMsg(e.message ?? 'Connection failed')
    }
  }

  async function handleAdd() {
    const ds = buildDs()
    // Save to backend
    try {
      await setupApi.addDatasource(ds)
    } catch {
      // best-effort
    }
    onAdd({ ...ds, tested: testStatus === 'ok' })
    // reset form
    setUrl('')
    setName('')
    setTestStatus('idle')
    setTestMsg('')
  }

  return (
    <div className="border border-outline/20 rounded-2xl p-4 space-y-4 bg-surface-high">
      <div className="grid grid-cols-2 gap-3">
        <FormGroup label="Type">
          <Select
            value={type}
            onChange={(v) => {
              setType(v as DatasourceType)
              setTestStatus('idle')
            }}
            options={DS_TYPES.map((d) => ({ value: d.value, label: d.label }))}
          />
        </FormGroup>
        <FormGroup label="Environment">
          <Input placeholder="production" value={env} onChange={setEnv} />
        </FormGroup>
      </div>

      <FormGroup label="URL">
        <Input placeholder={dsType.placeholder} value={url} onChange={setUrl} />
      </FormGroup>

      <FormGroup label="Name (optional)">
        <Input placeholder={`${dsType.label} (${env})`} value={name} onChange={setName} />
      </FormGroup>

      <FormGroup label="Authentication">
        <Select
          value={authType}
          onChange={(v) => setAuthType(v as typeof authType)}
          options={[
            { value: 'none', label: 'No authentication' },
            { value: 'basic', label: 'Basic auth (username / password)' },
            { value: 'bearer', label: 'Bearer token' },
          ]}
        />
      </FormGroup>

      {authType === 'basic' && (
        <div className="grid grid-cols-2 gap-3">
          <FormGroup label="Username">
            <Input value={username} onChange={setUsername} />
          </FormGroup>
          <FormGroup label="Password">
            <Input type="password" value={password} onChange={setPassword} />
          </FormGroup>
        </div>
      )}

      {authType === 'bearer' && (
        <FormGroup label="Token">
          <Input type="password" placeholder="Bearer token" value={token} onChange={setToken} />
        </FormGroup>
      )}

      <StatusBadge status={testStatus} message={testMsg} />

      <div className="flex gap-3">
        <button
          onClick={handleTest}
          disabled={!canTest || testStatus === 'testing'}
          className="flex items-center gap-2 px-3 py-2 rounded-xl border border-outline/40 text-sm text-on-surface-variant hover:bg-surface hover:text-on-surface transition-all disabled:opacity-40"
        >
          <span className="material-symbols-rounded text-base">wifi_tethering</span>
          Test
        </button>
        <button
          onClick={handleAdd}
          disabled={!canTest}
          className="flex-1 flex items-center justify-center gap-2 gradient-primary rounded-xl py-2 text-sm font-medium text-black disabled:opacity-40"
        >
          <span className="material-symbols-rounded text-base">add</span>
          Add datasource
        </button>
      </div>
    </div>
  )
}

function StepDatasources({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const [added, setAdded] = useState<AddedDatasource[]>([])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display font-bold text-xl mb-1">Connect your data sources</h2>
        <p className="text-on-surface-variant text-sm">
          Add Prometheus (metrics), Loki (logs), or Tempo/Jaeger (traces). At least one metrics source is required.
        </p>
      </div>

      {/* Added list */}
      {added.length > 0 && (
        <div className="space-y-2">
          {added.map((ds, i) => (
            <div key={i} className="flex items-center gap-3 bg-surface-high rounded-xl px-4 py-3 text-sm">
              <span className={`material-symbols-rounded text-base ${ds.tested ? 'text-secondary' : 'text-on-surface-variant'}`}>
                {ds.tested ? 'check_circle' : 'radio_button_unchecked'}
              </span>
              <span className="font-medium text-on-surface">{ds.name}</span>
              <span className="text-on-surface-variant text-xs">{ds.url}</span>
              <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">{ds.environment}</span>
            </div>
          ))}
        </div>
      )}

      <DatasourceForm onAdd={(ds) => setAdded((prev) => [...prev, ds])} />

      <div className="flex gap-3 pt-2">
        <button
          onClick={onSkip}
          className="px-4 py-2 rounded-xl text-sm text-on-surface-variant hover:text-on-surface transition-all"
        >
          Skip for now
        </button>
        <button
          onClick={onNext}
          disabled={added.length === 0}
          className="flex-1 gradient-primary rounded-xl py-2 text-sm font-medium text-black disabled:opacity-40"
        >
          Continue → ({added.length} source{added.length !== 1 ? 's' : ''} added)
        </button>
      </div>
    </div>
  )
}

// ─── Step 3: Notifications ────────────────────────────────────────────────────

function StepNotifications({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const [slackUrl, setSlackUrl] = useState('')
  const [slackChannel, setSlackChannel] = useState('#incidents')
  const [pdKey, setPdKey] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      const config: Record<string, any> = {}
      if (slackUrl.trim()) config.slack = { webhookUrl: slackUrl.trim(), channel: slackChannel }
      if (pdKey.trim()) config.pagerduty = { integrationKey: pdKey.trim() }
      if (Object.keys(config).length > 0) {
        await setupApi.configureNotifications(config)
      }
      onNext()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display font-bold text-xl mb-1">Set up notifications</h2>
        <p className="text-on-surface-variant text-sm">
          Get alerted when Curator detects anomalies or fires alert rules. You can add more channels later.
        </p>
      </div>

      {/* Slack */}
      <div className="border border-outline/20 rounded-2xl p-4 space-y-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="material-symbols-rounded text-on-surface-variant">chat</span>
          <span className="font-medium text-sm">Slack</span>
        </div>
        <FormGroup label="Incoming Webhook URL" hint="Create one at api.slack.com/messaging/webhooks">
          <Input placeholder="https://hooks.slack.com/services/..." value={slackUrl} onChange={setSlackUrl} />
        </FormGroup>
        <FormGroup label="Default channel">
          <Input placeholder="#incidents" value={slackChannel} onChange={setSlackChannel} />
        </FormGroup>
      </div>

      {/* PagerDuty */}
      <div className="border border-outline/20 rounded-2xl p-4 space-y-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="material-symbols-rounded text-error">emergency</span>
          <span className="font-medium text-sm">PagerDuty</span>
        </div>
        <FormGroup label="Integration Key (Events API v2)" hint="Found in your PagerDuty service settings">
          <Input type="password" placeholder="••••••••••••••••" value={pdKey} onChange={setPdKey} />
        </FormGroup>
      </div>

      <div className="flex gap-3 pt-2">
        <button
          onClick={onSkip}
          className="px-4 py-2 rounded-xl text-sm text-on-surface-variant hover:text-on-surface transition-all"
        >
          Skip for now
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 gradient-primary rounded-xl py-2 text-sm font-medium text-black disabled:opacity-40"
        >
          {saving ? 'Saving...' : 'Continue →'}
        </button>
      </div>
    </div>
  )
}

// ─── Step 4: Done ─────────────────────────────────────────────────────────────

function StepDone({ onFinish }: { onFinish: () => void }) {
  const [loading, setLoading] = useState(false)

  async function handleFinish() {
    setLoading(true)
    try {
      await setupApi.complete()
    } finally {
      setLoading(false)
      onFinish()
    }
  }

  return (
    <div className="space-y-8 text-center">
      <div className="w-20 h-20 rounded-3xl gradient-primary flex items-center justify-center mx-auto">
        <span className="material-symbols-rounded text-4xl text-black">auto_awesome</span>
      </div>

      <div>
        <h2 className="font-display font-extrabold text-2xl mb-2">You're all set!</h2>
        <p className="text-on-surface-variant text-sm max-w-xs mx-auto">
          Curator is ready to analyze your telemetry, generate dashboards, and investigate incidents.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3 text-left">
        {[
          { icon: 'grid_view', label: 'AI Dashboards', desc: 'Generate from natural language' },
          { icon: 'search', label: 'Investigations', desc: 'Automated root cause analysis' },
          { icon: 'notifications', label: 'Smart Alerts', desc: 'Threshold detection & routing' },
        ].map((item) => (
          <div key={item.label} className="bg-surface-high rounded-2xl p-4 space-y-2">
            <span className="material-symbols-rounded text-primary text-2xl">{item.icon}</span>
            <div>
              <div className="text-sm font-medium text-on-surface">{item.label}</div>
              <div className="text-xs text-on-surface-variant">{item.desc}</div>
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={handleFinish}
        disabled={loading}
        className="w-full gradient-primary rounded-xl py-3 font-medium text-black text-base"
      >
        {loading ? 'Launching...' : 'Open Curator →'}
      </button>
    </div>
  )
}

// ─── Main Setup page ──────────────────────────────────────────────────────────

export default function Setup() {
  const [step, setStep] = useState(0)
  const navigate = useNavigate()

  const next = () => setStep((s) => s + 1)

  return (
    <div className="min-h-screen bg-surface-base flex flex-col items-center justify-center p-6">
      {/* Header */}
      <div className="mb-10 text-center">
        <div className="flex items-center justify-center gap-2 mb-4">
          <div className="w-10 h-10 rounded-xl gradient-primary flex items-center justify-center">
            <span className="material-symbols-rounded text-black text-xl">auto_awesome</span>
          </div>
          <span className="font-display font-extrabold text-xl gradient-text">Curator</span>
        </div>
        <p className="text-on-surface-variant text-sm">AI-native observability platform</p>
      </div>

      {/* Step indicator */}
      {step < 4 && (
        <div className="mb-8">
          <StepIndicator current={step} />
        </div>
      )}

      {/* Card */}
      <div className="w-full max-w-lg bg-surface-low rounded-3xl p-8">
        {step === 0 && <StepLLM onNext={next} />}
        {step === 1 && <StepDatasources onNext={next} onSkip={next} />}
        {step === 2 && <StepNotifications onNext={next} onSkip={next} />}
        {step === 3 && <StepDone onFinish={() => navigate('/')} />}
      </div>

      {/* Skip all (for dev) */}
      {step < 3 && (
        <button
          onClick={() => setStep(3)}
          className="mt-6 text-xs text-on-surface-variant/40 hover:text-on-surface-variant transition-all"
        >
          Skip setup
        </button>
      )}
    </div>
  )
}
