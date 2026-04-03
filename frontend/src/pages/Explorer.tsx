import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { SideNav } from '@/components/layout/SideNav'
import { AIPanel } from '@/components/layout/AIPanel'
import { Badge } from '@/components/ui/Badge'
import { StatusDot } from '@/components/ui/StatusDot'
import { Button } from '@/components/ui/Button'
import { useAIPanel } from '@/stores/aiPanel'
import { explorerApi, Asset, AssetType, AssetStatus } from '@/api/explorer'

// Fallback shown while loading or if backend is unavailable
const FALLBACK_ASSETS: Asset[] = [
  { id: '1', name: 'Kubernetes Cluster Health', type: 'dashboard', status: 'healthy', origin: 'ai_generated', lastActivity: '12m ago', author: 'AI', tags: ['production'] },
  { id: '2', name: 'Auth Service Spike Analysis', type: 'report', status: 'critical', origin: 'manual', lastActivity: '3h ago', author: 'Alex', tags: ['production'] },
  { id: '3', name: 'Postgres Read Latency', type: 'dashboard', status: 'healthy', origin: 'manual', lastActivity: '1d ago', author: 'Sam', tags: ['staging'] },
]

const FOLDERS = [
  { id: 'all', label: 'All Assets', count: 415 },
  { id: 'production', label: 'Production', count: 243 },
  { id: 'staging', label: 'Staging', count: 87 },
  { id: 'team-alpha', label: 'Team Alpha', count: 54 },
  { id: 'ai-insights', label: 'AI Insights', count: 31 },
]

const TYPE_ICONS: Record<string, string> = {
  dashboard: 'grid_view',
  report: 'description',
  alert: 'notifications',
}

export default function Explorer() {
  const [activeFolder, setActiveFolder] = useState('all')
  const [filterType, setFilterType] = useState<AssetType | 'all'>('all')
  const { isOpen, addMessage } = useAIPanel()

  const { data: explorerData, isLoading } = useQuery({
    queryKey: ['explorer', filterType],
    queryFn: () => explorerApi.list(filterType !== 'all' ? { type: filterType } : undefined),
  })

  const assets = explorerData?.assets ?? FALLBACK_ASSETS

  const statusVariant = (status: AssetStatus) => {
    if (status === 'healthy') return 'secondary' as const
    if (status === 'critical') return 'error' as const
    return 'outline' as const
  }

  return (
    <div className="flex h-screen bg-surface-base overflow-hidden">
      <SideNav />

      {/* Folder sidebar */}
      <div className="w-48 flex-shrink-0 bg-surface-low flex flex-col py-4">
        <div className="px-4 mb-4">
          <span className="text-xs font-medium text-on-surface-variant uppercase tracking-widest">Library</span>
        </div>
        <div className="flex flex-col gap-0.5 px-2">
          {FOLDERS.map((folder) => (
            <button
              key={folder.id}
              onClick={() => setActiveFolder(folder.id)}
              className={`flex items-center justify-between px-3 py-2 rounded-xl text-sm transition-all ${
                activeFolder === folder.id
                  ? 'bg-primary/20 text-primary'
                  : 'text-on-surface-variant hover:bg-surface-high hover:text-on-surface'
              }`}
            >
              <span className="truncate">{folder.label}</span>
              <span className="text-xs opacity-60">{folder.count}</span>
            </button>
          ))}
        </div>
        <div className="mt-auto px-3">
          <button className="w-full text-xs text-on-surface-variant/60 hover:text-on-surface-variant py-2 flex items-center gap-1">
            <span className="material-symbols-rounded text-sm">create_new_folder</span>
            New Folder
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden bg-surface">
        {/* Header */}
        <div className="px-6 py-4 flex items-center justify-between flex-shrink-0">
          <div>
            <h1 className="font-display font-bold text-lg">All Assets</h1>
            <p className="text-on-surface-variant text-sm">Manage and filter your observability library</p>
          </div>
          <Button size="sm">
            <span className="material-symbols-rounded text-base">upload</span>
            Import Asset
          </Button>
        </div>

        {/* Filter bar */}
        <div className="px-6 pb-4 flex items-center gap-3 flex-shrink-0">
          {['all', 'dashboard', 'report', 'alert'].map((type) => (
            <button
              key={type}
              onClick={() => setFilterType(type)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-all ${
                filterType === type
                  ? 'bg-primary/20 text-primary'
                  : 'bg-surface-high text-on-surface-variant hover:text-on-surface'
              }`}
            >
              {type}
            </button>
          ))}
        </div>

        {/* Table */}
        <div className="flex-1 overflow-y-auto px-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-on-surface-variant text-xs uppercase tracking-wider border-b border-outline/20">
                <th className="text-left pb-3 font-medium">Asset Name</th>
                <th className="text-left pb-3 font-medium">Type</th>
                <th className="text-left pb-3 font-medium">Status</th>
                <th className="text-left pb-3 font-medium">Last Activity</th>
                <th className="text-left pb-3 font-medium">Author</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => (
                <tr key={asset.id} className="border-b border-outline/10 hover:bg-white/[0.02] transition-all">
                  <td className="py-3.5">
                    <Link
                      to={asset.type === 'dashboard' ? `/dashboards/${asset.id}` : `/reports/${asset.id}`}
                      className="flex items-center gap-2 text-on-surface hover:text-primary transition-all"
                    >
                      <span className="material-symbols-rounded text-on-surface-variant text-base">
                        {TYPE_ICONS[asset.type]}
                      </span>
                      {asset.name}
                    </Link>
                  </td>
                  <td className="py-3.5">
                    <Badge variant={asset.origin === 'ai_generated' ? 'primary' : 'tertiary'}>
                      {asset.origin === 'ai_generated' ? 'AI Generated' : 'Manual'}
                    </Badge>
                  </td>
                  <td className="py-3.5">
                    <div className="flex items-center gap-2">
                      <StatusDot status={asset.status} />
                      <span className="capitalize text-on-surface-variant">{asset.status}</span>
                    </div>
                  </td>
                  <td className="py-3.5 text-on-surface-variant">{asset.lastActivity}</td>
                  <td className="py-3.5 text-on-surface-variant">{asset.author}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="py-4 flex items-center justify-between text-on-surface-variant text-xs">
            <span>{isLoading ? 'Loading...' : `Showing ${assets.length} of ${explorerData?.total ?? assets.length} results`}</span>
            <div className="flex items-center gap-1">
              {[1, 2, 3, '...', 8].map((p, i) => (
                <button key={i} className={`w-7 h-7 rounded-lg ${p === 1 ? 'bg-primary/20 text-primary' : 'hover:bg-surface-high'}`}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Right: AI Panel */}
      {isOpen && (
        <AIPanel
          suggestions={[
            { label: 'Compare Dashboard trends', icon: 'compare_arrows' },
            { label: 'Find critical alerts in prod', icon: 'crisis_alert' },
            { label: 'Generate Weekly Report', icon: 'summarize' },
          ]}
          onSend={(msg) => addMessage({ role: 'user', content: msg })}
          placeholder="Ask AI Curator..."
        />
      )}
    </div>
  )
}
