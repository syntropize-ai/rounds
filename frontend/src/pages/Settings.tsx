import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { setupApi, LLMConfig, DatasourceConfig, LLMProvider, DatasourceType } from '@/api/setup'
import { SideNav } from '@/components/layout/SideNav'

// ── Shared primitives (same style as Setup) ───────────────────────────────────
function FormGroup({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-on-surface-variant">{label}</label>
      {children}
      {hint && <p className="text-xs text-on-surface-variant/60">{hint}</p>}
    </div>
  )
}
function Input({ type = 'text', placeholder, value, onChange, disabled }: {
  type?: string; placeholder?: string; value: string; onChange?: (v: string) => void; disabled?: boolean
}) {
  return (
    <input
      type={type} value={value} placeholder={placeholder} disabled={disabled}
      onChange={(e) => onChange?.(e.target.value)}
      className="w-full bg-surface-high border border-outline/30 rounded-xl px-4 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/50 outline-none focus:border-primary/60 transition-all disabled:opacity-50"
    />
  )
}
function Sel({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="w-full bg-surface-high border border-outline/30 rounded-xl px-4 py-2.5 text-sm text-on-surface outline-none focus:border-primary/60 transition-all appearance-none">
      {options.map((o) => <option key={o.value} value={o.value} className="bg-surface-high">{o.label}</option>)}
    </select>
  )
}
function StatusBadge({ status, message }: { status: 'idle' | 'testing' | 'ok' | 'error' | 'saving'; message?: string }) {
  if (status === 'idle') return null
  const cfg = {
    testing: { bg: 'bg-primary/10 text-primary', icon: 'progress_activity', spin: true, msg: 'Testing...' },
    saving:  { bg: 'bg-primary/10 text-primary', icon: 'progress_activity', spin: true, msg: 'Saving...' },
    ok:      { bg: 'bg-secondary/10 text-secondary', icon: 'check_circle', spin: false, msg: 'Saved!' },
    error:   { bg: 'bg-error/10 text-error', icon: 'error', spin: false, msg: 'Failed' },
  }[status]
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm mt-2 ${cfg.bg}`}>
      <span className={`material-symbols-rounded text-base ${cfg.spin ? 'animate-spin' : ''}`}>{cfg.icon}</span>
      {message || cfg.msg}
    </div>
  )
}

// ── LLM Section ───────────────────────────────────────────────────────────────
const LLM_PROVIDERS: { value: LLMProvider; label: string; models: string[] }[] = [
  { value: 'anthropic', label: 'Anthropic (Claude)', models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'] },
  { value: 'openai', label: 'OpenAI', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'] },
  { value: 'azure-openai', label: 'Azure OpenAI', models: ['gpt-4o', 'gpt-4-turbo'] },
  { value: 'aws-bedrock', label: 'AWS Bedrock', models: ['anthropic.claude-3-5-sonnet-20241022-v2:0'] },
  { value: 'corporate-gateway', label: 'Corporate LLM Gateway', models: ['auto'] },
  { value: 'gemini', label: 'Google Gemini', models: ['gemini-3-flash-preview', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'] },
  { value: 'ollama', label: 'Ollama (Local)', models: ['llama3.2', 'llama3.1', 'mistral', 'qwen2.5'] },
]

function LLMSection({ initial }: { initial: (LLMConfig & { apiKey?: string }) | null }) {
  const [provider, setProvider] = useState<LLMProvider>(initial?.provider ?? 'anthropic')
  const [model, setModel] = useState(initial?.model ?? 'claude-sonnet-4-6')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '')
  const [awsRegion, setAwsRegion] = useState(initial?.awsRegion ?? 'us-east-1')
  const [awsKeyId, setAwsKeyId] = useState(initial?.awsAccessKeyId ?? '')
  const [awsSecret, setAwsSecret] = useState('')
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [ollamaFetching, setOllamaFetching] = useState(false)
  const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'error' | 'saving'>('idle')
  const [statusMsg, setStatusMsg] = useState('')
  const fetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const hasExistingKey = initial?.apiKey === '********'

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
        }
      } catch { /* ignore */ } finally { setOllamaFetching(false) }
    }, 600)
    return () => { if (fetchTimer.current) clearTimeout(fetchTimer.current) }
  }, [provider, baseUrl])

  function buildConfig(): LLMConfig {
    const cfg: LLMConfig = { provider, model }
    if (provider === 'anthropic' || provider === 'openai' || provider === 'gemini') { if (apiKey) cfg.apiKey = apiKey }
    if (provider === 'azure-openai' || provider === 'corporate-gateway') { if (apiKey) cfg.apiKey = apiKey; cfg.baseUrl = baseUrl }
    if (provider === 'ollama') cfg.baseUrl = baseUrl
    if (provider === 'aws-bedrock') { cfg.awsRegion = awsRegion; cfg.awsAccessKeyId = awsKeyId; if (awsSecret) cfg.awsSecretAccessKey = awsSecret }
    return cfg
  }

  async function handleTest() {
    setStatus('testing'); setStatusMsg('')
    try {
      const res = await setupApi.testLLM(buildConfig())
      if (res.ok) { setStatus('ok'); setStatusMsg(`Connected! ${res.latencyMs ? `(${res.latencyMs}ms)` : ''}`) }
      else { setStatus('error'); setStatusMsg(res.error ?? 'Failed') }
    } catch (e: any) { setStatus('error'); setStatusMsg(e.message) }
  }

  async function handleSave() {
    setStatus('saving'); setStatusMsg('')
    try {
      await setupApi.configureLLM(buildConfig())
      setStatus('ok'); setStatusMsg('LLM settings saved!')
    } catch (e: any) { setStatus('error'); setStatusMsg(e.message) }
  }

  const providerMeta = LLM_PROVIDERS.find((p) => p.value === provider)!
  const canSave =
    provider === 'ollama' ? baseUrl.length > 0 :
    provider === 'aws-bedrock' ? awsKeyId.length > 0 :
    provider === 'corporate-gateway' ? baseUrl.length > 0 :
    apiKey.length > 0 || hasExistingKey

  return (
    <div className="space-y-4">
      <FormGroup label="Provider">
        <Sel value={provider} onChange={(v) => { setProvider(v as LLMProvider); setModel(LLM_PROVIDERS.find(p=>p.value===v)!.models[0]); if(v==='ollama') setBaseUrl(baseUrl||'http://localhost:11434') }} options={LLM_PROVIDERS.map(p=>({value:p.value,label:p.label}))} />
      </FormGroup>

      {provider === 'ollama' && (
        <FormGroup label="Ollama Base URL">
          <div className="flex gap-2">
            <Input placeholder="http://localhost:11434" value={baseUrl} onChange={setBaseUrl} />
            <button onClick={() => { const c=baseUrl.trim(); setBaseUrl(c+' '); setTimeout(()=>setBaseUrl(c),50) }}
              className="flex-shrink-0 w-10 h-10 rounded-xl border border-outline/40 text-on-surface-variant hover:bg-surface-high flex items-center justify-center">
              <span className={`material-symbols-rounded text-base ${ollamaFetching?'animate-spin':''}`}>refresh</span>
            </button>
          </div>
        </FormGroup>
      )}

      <FormGroup label="Model">
        {provider === 'ollama' && ollamaModels.length > 0
          ? <Sel value={model} onChange={setModel} options={ollamaModels.map(m=>({value:m,label:m}))} />
          : provider === 'ollama'
          ? <Input placeholder={ollamaFetching ? 'Fetching models...' : 'e.g. llama3.2'} value={model} onChange={setModel} />
          : <Sel value={model} onChange={setModel} options={providerMeta.models.map(m=>({value:m,label:m}))} />
        }
      </FormGroup>

      {(provider === 'anthropic' || provider === 'openai' || provider === 'azure-openai' || provider === 'gemini') && (
        <FormGroup label="API Key" hint={hasExistingKey ? 'Leave blank to keep existing key' : undefined}>
          <Input type="password" placeholder={hasExistingKey ? '••••••••  (unchanged)' : 'Paste your API key'} value={apiKey} onChange={setApiKey} />
        </FormGroup>
      )}

      {(provider === 'azure-openai' || provider === 'corporate-gateway') && (
        <FormGroup label="Base URL">
          <Input placeholder="https://" value={baseUrl} onChange={setBaseUrl} />
        </FormGroup>
      )}

      {provider === 'aws-bedrock' && (
        <>
          <FormGroup label="AWS Region"><Input placeholder="us-east-1" value={awsRegion} onChange={setAwsRegion} /></FormGroup>
          <FormGroup label="Access Key ID"><Input placeholder="AKIA..." value={awsKeyId} onChange={setAwsKeyId} /></FormGroup>
          <FormGroup label="Secret Access Key" hint="Leave blank to keep existing"><Input type="password" placeholder="••••••••" value={awsSecret} onChange={setAwsSecret} /></FormGroup>
        </>
      )}

      <StatusBadge status={status} message={statusMsg} />

      <div className="flex gap-2 pt-1">
        <button onClick={handleTest} disabled={!canSave || status==='testing'}
          className="flex items-center gap-2 px-4 py-2 rounded-xl border border-outline/40 text-sm text-on-surface-variant hover:bg-surface-high hover:text-on-surface transition-all disabled:opacity-40">
          <span className="material-symbols-rounded text-base">wifi_tethering</span>
          Test
        </button>
        <button onClick={handleSave} disabled={!canSave || status==='saving'}
          className="flex-1 gradient-primary rounded-xl py-2 text-sm font-medium text-black disabled:opacity-40">
          Save LLM settings
        </button>
      </div>
    </div>
  )
}

// ── Datasources Section ───────────────────────────────────────────────────────
const DS_TYPES: { value: DatasourceType; label: string; placeholder: string }[] = [
  { value: 'prometheus', label: 'Prometheus', placeholder: 'http://localhost:9090' },
  { value: 'victoria-metrics', label: 'VictoriaMetrics', placeholder: 'http://localhost:8428' },
  { value: 'loki', label: 'Loki', placeholder: 'http://localhost:3100' },
  { value: 'tempo', label: 'Tempo', placeholder: 'http://localhost:3200' },
  { value: 'jaeger', label: 'Jaeger', placeholder: 'http://localhost:16686' },
  { value: 'elasticsearch', label: 'Elasticsearch', placeholder: 'http://localhost:9200' },
]

function DatasourcesSection({ initial }: { initial: (DatasourceConfig & { id?: string })[] }) {
  const [list, setList] = useState(initial)
  const [type, setType] = useState<DatasourceType>('prometheus')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [authType, setAuthType] = useState<'none' | 'basic' | 'bearer'>('none')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle')
  const [testMsg, setTestMsg] = useState('')

  const dsType = DS_TYPES.find((d) => d.value === type)!

  function buildDs(): DatasourceConfig {
    return {
      name: name || `${dsType.label}`,
      type,
      url: url.trim(),
      isDefault: list.length === 0,
      auth: authType === 'none' ? { type: 'none' }
        : authType === 'basic' ? { type: 'basic', username, password }
        : { type: 'bearer', token },
    }
  }

  async function handleTest() {
    setTestStatus('testing'); setTestMsg('')
    try {
      const res = await setupApi.testDatasource(buildDs())
      if (res.ok) { setTestStatus('ok'); setTestMsg(`Connected! ${res.latencyMs?`(${res.latencyMs}ms)`:''}`) }
      else { setTestStatus('error'); setTestMsg(res.error ?? 'Failed') }
    } catch (e: any) { setTestStatus('error'); setTestMsg(e.message) }
  }

  async function handleAdd() {
    try {
      const res = await setupApi.addDatasource(buildDs()) as any
      const added = { ...buildDs(), id: res.datasource?.id }
      setList((prev) => [...prev, added])
      setUrl(''); setName(''); setTestStatus('idle'); setTestMsg('')
    } catch (e: any) { setTestStatus('error'); setTestMsg(e.message) }
  }

  async function handleDelete(id: string | undefined, idx: number) {
    if (!id) { setList((prev) => prev.filter((_, i) => i !== idx)); return }
    try {
      await setupApi.deleteDatasource(id)
      setList((prev) => prev.filter((_, i) => i !== idx))
    } catch (e: any) { alert('Delete failed: ' + e.message) }
  }

  return (
    <div className="space-y-4">
      {/* Existing datasources */}
      {list.length > 0 && (
        <div className="space-y-2">
          {list.map((ds, i) => (
            <div key={i} className="flex items-center gap-3 bg-surface-high rounded-xl px-4 py-3 text-sm">
              <span className="material-symbols-rounded text-base text-secondary">database</span>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-on-surface truncate">{ds.name}</div>
                <div className="text-xs text-on-surface-variant truncate">{ds.url}</div>
              </div>
              <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary flex-shrink-0">{ds.type}</span>
              {ds.isDefault && <span className="text-xs px-2 py-0.5 rounded-full bg-secondary/10 text-secondary flex-shrink-0">default</span>}
              <button onClick={() => handleDelete(ds.id, i)}
                className="text-on-surface-variant/40 hover:text-error transition-colors flex-shrink-0">
                <span className="material-symbols-rounded text-base">delete</span>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add form */}
      <div className="border border-outline/20 rounded-2xl p-4 space-y-4 bg-surface-high">
        <p className="text-xs font-semibold text-on-surface-variant uppercase tracking-wider">Add datasource</p>
        <div className="grid grid-cols-2 gap-3">
          <FormGroup label="Type">
            <Sel value={type} onChange={(v) => setType(v as DatasourceType)} options={DS_TYPES.map(d=>({value:d.value,label:d.label}))} />
          </FormGroup>
          <FormGroup label="Name">
            <Input placeholder={dsType.label} value={name} onChange={setName} />
          </FormGroup>
        </div>
        <FormGroup label="URL">
          <Input placeholder={dsType.placeholder} value={url} onChange={setUrl} />
        </FormGroup>
        <FormGroup label="Auth">
          <Sel value={authType} onChange={(v) => setAuthType(v as typeof authType)}
            options={[{value:'none',label:'No auth'},{value:'basic',label:'Basic'},{value:'bearer',label:'Bearer token'}]} />
        </FormGroup>
        {authType === 'basic' && (
          <div className="grid grid-cols-2 gap-3">
            <FormGroup label="Username"><Input value={username} onChange={setUsername} /></FormGroup>
            <FormGroup label="Password"><Input type="password" value={password} onChange={setPassword} /></FormGroup>
          </div>
        )}
        {authType === 'bearer' && (
          <FormGroup label="Token"><Input type="password" placeholder="Bearer token" value={token} onChange={setToken} /></FormGroup>
        )}
        <StatusBadge status={testStatus} message={testMsg} />
        <div className="flex gap-2">
          <button onClick={handleTest} disabled={!url.trim() || testStatus==='testing'}
            className="flex items-center gap-2 px-3 py-2 rounded-xl border border-outline/40 text-sm text-on-surface-variant hover:bg-surface hover:text-on-surface disabled:opacity-40">
            <span className="material-symbols-rounded text-base">wifi_tethering</span>Test
          </button>
          <button onClick={handleAdd} disabled={!url.trim()}
            className="flex-1 flex items-center justify-center gap-2 gradient-primary rounded-xl py-2 text-sm font-medium text-black disabled:opacity-40">
            <span className="material-symbols-rounded text-base">add</span>Add
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Settings page ─────────────────────────────────────────────────────────────
export default function Settings() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<'llm' | 'datasources'>('llm')
  const [config, setConfig] = useState<Awaited<ReturnType<typeof setupApi.getConfig>> | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setupApi.getConfig().then(setConfig).finally(() => setLoading(false))
  }, [])

  const tabs = [
    { id: 'llm', label: 'LLM', icon: 'smart_toy' },
    { id: 'datasources', label: 'Datasources', icon: 'database' },
  ] as const

  return (
    <div className="flex h-screen bg-surface-base overflow-hidden">
      <SideNav />
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-4 px-6 h-14 bg-surface flex-shrink-0 border-b border-surface-highest">
          <button onClick={() => navigate(-1)} className="text-on-surface-variant hover:text-on-surface transition-colors">
            <span className="material-symbols-rounded text-xl">arrow_back</span>
          </button>
          <h1 className="font-display font-bold text-base text-on-surface">Settings</h1>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-2xl mx-auto">
            {/* Tabs */}
            <div className="flex gap-1 bg-surface-high rounded-xl p-1 mb-6 w-fit">
              {tabs.map((t) => (
                <button key={t.id} onClick={() => setTab(t.id)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${tab === t.id ? 'bg-surface text-on-surface shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}>
                  <span className="material-symbols-rounded text-base">{t.icon}</span>
                  {t.label}
                </button>
              ))}
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-20 text-on-surface-variant text-sm">Loading...</div>
            ) : (
              <div className="bg-surface-low rounded-2xl p-6">
                {tab === 'llm' && <LLMSection initial={config?.llm ?? null} />}
                {tab === 'datasources' && <DatasourcesSection initial={config?.datasources ?? []} />}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
