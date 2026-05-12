import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Hyveon',
  tagline: 'Cost-efficient multi-game dedicated server platform on AWS Fargate',
  url: 'https://codercoco.github.io',
  baseUrl: '/Hyveon/',

  organizationName: 'CoderCoco',
  projectName: 'Hyveon',

  onBrokenLinks: 'warn',
  onBrokenMarkdownLinks: 'warn',

  markdown: {
    mermaid: true,
  },

  themes: ['@docusaurus/theme-mermaid'],

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: '/',
          editUrl:
            'https://github.com/CoderCoco/Hyveon/tree/main/docs/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: 'light',
      disableSwitch: false,
      // Automatically follow the user's OS light/dark preference
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'Hyveon',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          href: 'https://github.com/CoderCoco/Hyveon',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {label: 'Setup Guide', to: '/setup'},
            {label: 'Architecture', to: '/architecture'},
            {label: 'User Guide', to: '/guides/user'},
            {label: 'Maintainer Guide', to: '/guides/maintainer'},
          ],
        },
        {
          title: 'More',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/CoderCoco/Hyveon',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Hyveon. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'hcl', 'json'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
