import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Rounds',
  description: 'Docs for Rounds — AI does rounds on your production. By Syntropize.',
  srcDir: '.',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
  ],
  themeConfig: {
    logo: {
      light: '/rounds-logo.svg',
      dark: '/rounds-logo-dark.svg',
    },
    siteTitle: 'Rounds',
    nav: [
      { text: 'Get Started', link: '/getting-started' },
      { text: 'User Guide', link: '/features/chat' },
      { text: 'Security', link: '/auth' },
      { text: 'GitHub', link: 'https://github.com/syntropize/rounds' },
    ],
    sidebar: [
      {
        text: 'Get Started',
        items: [
          { text: 'Introduction', link: '/' },
          { text: 'Quick start', link: '/getting-started' },
          { text: 'Configuration', link: '/configuration' },
        ],
      },
      {
        text: 'Install',
        items: [
          { text: 'npm (single machine)', link: '/install/npm' },
          { text: 'Kubernetes (Helm)', link: '/install/kubernetes' },
        ],
      },
      {
        text: 'User Guide',
        items: [
          { text: 'Chat & agent', link: '/features/chat' },
          { text: 'Dashboards', link: '/features/dashboards' },
          { text: 'Alert rules', link: '/features/alerts' },
          { text: 'Investigations', link: '/features/investigations' },
          { text: 'Feed', link: '/features/feed' },
          { text: 'Action Center', link: '/features/action-center' },
          { text: 'Connectors', link: '/features/datasources' },
        ],
      },
      {
        text: 'Administration',
        items: [
          { text: 'Setup wizard', link: '/features/admin#setup-wizard' },
          { text: 'Settings', link: '/features/admin#settings' },
          { text: 'Users, teams, and roles', link: '/features/admin#users-teams-and-roles' },
          { text: 'Authentication', link: '/auth#authentication-methods' },
          { text: 'Permissions & RBAC', link: '/auth#built-in-roles-permission-summary' },
          { text: 'Service accounts & tokens', link: '/auth#service-accounts-and-api-tokens' },
          { text: 'Production checklist', link: '/auth#production-security-checklist' },
        ],
      },
      {
        text: 'Operations',
        items: [
          { text: 'Auto-remediation', link: '/operations/auto-remediation' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Configuration env vars', link: '/configuration' },
          { text: 'REST API', link: '/api-reference' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/syntropize/rounds' },
    ],
    search: {
      provider: 'local',
    },
    footer: {
      message: 'Released under the AGPL-3.0-or-later License.',
      copyright: 'Copyright (c) Syntropize',
    },
  },
});
