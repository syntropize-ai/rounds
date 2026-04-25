import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'OpenObs',
  description: 'Docs for OpenObs, the AI-native observability platform.',
  srcDir: '.',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
  ],
  themeConfig: {
    logo: '/openobs-logo.svg',
    siteTitle: 'OpenObs',
    nav: [
      { text: 'Get Started', link: '/getting-started' },
      { text: 'Install', link: '/install/npm' },
      { text: 'Features', link: '/features/dashboards' },
      { text: 'Security', link: '/auth' },
      { text: 'GitHub', link: 'https://github.com/openobs/openobs' },
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
        text: 'Features',
        items: [
          { text: 'Dashboards', link: '/features/dashboards' },
          { text: 'Investigations', link: '/features/investigations' },
          { text: 'Alert rules', link: '/features/alerts' },
          { text: 'Datasources', link: '/features/datasources' },
          { text: 'Chat & agents', link: '/features/chat' },
        ],
      },
      {
        text: 'Security',
        items: [
          { text: 'Authentication', link: '/auth#authentication-methods' },
          { text: 'Permissions & RBAC', link: '/auth#built-in-roles-permission-summary' },
          { text: 'Service accounts & tokens', link: '/auth#service-accounts-and-api-tokens' },
          { text: 'Production checklist', link: '/auth#production-security-checklist' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Configuration env vars', link: '/configuration' },
          { text: 'REST API', link: '/api-reference' },
          { text: 'Architecture', link: '/architecture' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/openobs/openobs' },
    ],
    search: {
      provider: 'local',
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright (c) OpenObs',
    },
  },
});
