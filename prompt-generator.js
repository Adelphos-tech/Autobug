#!/usr/bin/env node
/**
 * Prompt Generator
 * Converts tickets into proper Claude prompts
 */

const fs = require('fs');
const path = require('path');

class PromptGenerator {
  constructor() {
    this.sshConfig = {
      host: process.env.SSH_HOST || '156.67.105.64',
      user: process.env.SSH_USER || 'root',
      password: process.env.SSH_PASSWORD || '30rZNitUz*un6vgz',
      repoPath: process.env.DEFAULT_REPO_PATH || '/var/www/adelphos_frontend'
    };
  }

  /**
   * Main entry: Convert ticket to prompt
   */
  generate(ticket) {
    const context = this.analyzeTicket(ticket);
    const prompt = this.buildPrompt(ticket, context);
    const executionPlan = this.createExecutionPlan(context);

    return {
      ticketId: ticket.id,
      originalDescription: ticket.description,
      context: context,
      prompt: prompt,
      executionPlan: executionPlan,
      autoExecute: true // Flag to auto-execute
    };
  }

  /**
   * Step 1: Analyze ticket context
   */
  analyzeTicket(ticket) {
    const desc = ticket.description.toLowerCase();

    const analysis = {
      // Issue classification
      issueType: this.classifyIssue(desc),

      // Affected areas
      affectedAreas: this.identifyAffectedAreas(desc),

      // Estimated files
      likelyFiles: this.guessFiles(desc),

      // Complexity
      complexity: this.assessComplexity(desc),

      // Required actions
      actions: this.determineActions(desc),

      // Technology stack
      techStack: this.detectTechStack(desc),

      // Keywords extracted
      keywords: this.extractKeywords(desc),

      // Confidence score
      confidence: this.calculateConfidence(desc)
    };

    return analysis;
  }

  /**
   * Classify the type of issue
   */
  classifyIssue(description) {
    const patterns = [
      // HIGH PRIORITY - SECURITY (check first)
      {
        pattern: /\b(security|auth|login|logout|password|token|jwt|session|cookie|encrypt|hash|https|ssl|tls)\b/,
        type: 'security-issue',
        category: 'security',
        priority: 'critical'
      },
      {
        pattern: /\b(vulnerability|xss|csrf|injection|sanitize|escape|validate)\b/,
        type: 'security-issue',
        category: 'security',
        priority: 'critical'
      },

      // HIGH PRIORITY - BACKEND & API (check before frontend)
      {
        pattern: /\b(api|endpoint|route|controller|handler|middleware|server-side|backend)\b/,
        type: 'backend-issue',
        category: 'backend',
        priority: 'high'
      },
      {
        pattern: /\b(database|db|query|sql|table|schema|migration|model|record|entry)\b/,
        type: 'database-issue',
        category: 'backend',
        priority: 'high'
      },
      {
        pattern: /\b(data|fetch|get|post|put|delete|patch)\b.*\b(api|request|response|json)\b/,
        type: 'api-issue',
        category: 'backend',
        priority: 'high'
      },
      {
        pattern: /\b(server error|500|404|status code|http|server\s+(?:issue|problem|error))\b/,
        type: 'backend-issue',
        category: 'backend',
        priority: 'high'
      },
      {
        pattern: /\b(server|deploy|deployment|build|compile|environment|config|setting)\b/,
        type: 'deployment-issue',
        category: 'backend',
        priority: 'high'
      },

      // CSS & STYLING (visual issues)
      {
        pattern: /\b(css|style|align|color|font|layout|padding|margin|border|background|width|height|display|position|flex|grid)\b/,
        type: 'css-styling',
        category: 'frontend',
        priority: 'low'
      },
      {
        pattern: /\b(mobile|responsive|phone|tablet|viewport|screen size|media query)\b/,
        type: 'css-styling',
        category: 'frontend',
        priority: 'low'
      },
      {
        pattern: /\b(fix|repair)\b.*\b(button|link|nav|menu|header|footer|layout|spacing|position|align|style)\b/,
        type: 'css-styling',
        category: 'frontend',
        priority: 'low'
      },
      {
        pattern: /\b(looks|appear|visual|ui|design)\b.*\b(off|wrong|broken|bad|weird|misaligned)\b/,
        type: 'css-styling',
        category: 'frontend',
        priority: 'low'
      },

      // CONTENT OPERATIONS
      {
        pattern: /\b(add|create|implement|new)\b.*\b(link|button|menu|nav|page|section|component|tab)\b/,
        type: 'content-addition',
        category: 'frontend',
        priority: 'low'
      },
      {
        pattern: /\b(remove|delete|hide|take out)\b.*\b(link|button|menu|nav|tab|item|section)\b/,
        type: 'content-removal',
        category: 'frontend',
        priority: 'low'
      },
      {
        pattern: /\b(update|change|modify|edit|replace)\b.*\b(text|content|wording|label|title|heading|paragraph|copy)\b/,
        type: 'content-update',
        category: 'content',
        priority: 'low'
      },
      {
        pattern: /\b(update|change)\b.*\b(image|photo|picture|logo|icon|banner|hero image)\b/,
        type: 'image-update',
        category: 'frontend',
        priority: 'low'
      },

      // JAVASCRIPT & FUNCTIONALITY (only if not backend)
      {
        pattern: /\b(fix|repair|broken|not working|error|bug|issue)\b.*\b(function|click|submit|load|display|show|hide|toggle|scroll|animate|event)\b/,
        type: 'functionality-bug',
        category: 'frontend',
        priority: 'medium'
      },
      {
        pattern: /\b(javascript|js|script|event|handler|listener|function|method|console\.log|error)\b/,
        type: 'javascript-issue',
        category: 'frontend',
        priority: 'medium'
      },
      {
        pattern: /\b(form|input|validation|submit|required|field|dropdown|checkbox|radio)\b/,
        type: 'form-issue',
        category: 'frontend',
        priority: 'medium'
      },

      // CONFIGURATION & INFRASTRUCTURE
      {
        pattern: /\b(config|configuration|env|environment|variable|\.env|setting|option)\b/,
        type: 'config-issue',
        category: 'infrastructure',
        priority: 'medium'
      },
      {
        pattern: /\b(package\.json|dependency|npm|install|module|import|require)\b/,
        type: 'dependency-issue',
        category: 'infrastructure',
        priority: 'medium'
      },
      {
        pattern: /\b(docker|container|compose|dockerfile)\b/,
        type: 'docker-issue',
        category: 'infrastructure',
        priority: 'medium'
      },
      {
        pattern: /\b(ci|cd|pipeline|github actions|jenkins|build|deploy|automation)\b/,
        type: 'cicd-issue',
        category: 'infrastructure',
        priority: 'medium'
      },

      // CONFIGURATION & INFRASTRUCTURE
      {
        pattern: /\b(config|configuration|env|environment|variable|\.env|setting|option)\b/,
        type: 'config-issue',
        category: 'infrastructure',
        priority: 'medium'
      },
      {
        pattern: /\b(package\.json|dependency|npm|install|module|import|require)\b/,
        type: 'dependency-issue',
        category: 'infrastructure',
        priority: 'medium'
      },
      {
        pattern: /\b(docker|container|compose|dockerfile)\b/,
        type: 'docker-issue',
        category: 'infrastructure',
        priority: 'medium'
      },
      {
        pattern: /\b(ci|cd|pipeline|github actions|jenkins|build|deploy|automation)\b/,
        type: 'cicd-issue',
        category: 'infrastructure',
        priority: 'medium'
      },

      // SECURITY
      {
        pattern: /\b(security|auth|login|logout|password|token|jwt|session|cookie|encrypt|hash|https|ssl|tls)\b/,
        type: 'security-issue',
        category: 'security',
        priority: 'critical'
      },
      {
        pattern: /\b(vulnerability|xss|csrf|injection|sanitize|escape|validate)\b/,
        type: 'security-issue',
        category: 'security',
        priority: 'critical'
      },

      // PERFORMANCE & OPTIMIZATION
      {
        pattern: /\b(performance|slow|optimize|speed|loading|cache|lazy|bundle|minify|compress|gzip)\b/,
        type: 'performance',
        category: 'optimization',
        priority: 'medium'
      },
      {
        pattern: /\b(memory|leak|cpu|usage|resource|efficient|optimize)\b/,
        type: 'performance',
        category: 'optimization',
        priority: 'medium'
      },

      // SEO & META
      {
        pattern: /\b(seo|meta|title|description|og:|twitter:|canonical|sitemap|robots)\b/,
        type: 'seo-issue',
        category: 'frontend',
        priority: 'low'
      },

      // ROUTING & NAVIGATION
      {
        pattern: /\b(route|routing|redirect|url|path|slug|page|404|not found)\b/,
        type: 'routing-issue',
        category: 'frontend',
        priority: 'medium'
      },

      // ACCESSIBILITY
      {
        pattern: /\b(accessibility|a11y|aria|screen reader|keyboard|tab|focus|contrast|alt text)\b/,
        type: 'accessibility',
        category: 'a11y',
        priority: 'medium'
      },

      // TESTING
      {
        pattern: /\b(test|spec|unit|integration|e2e|jest|mocha|cypress|playwright)\b/,
        type: 'testing-issue',
        category: 'testing',
        priority: 'medium'
      },

      // VERSION CONTROL
      {
        pattern: /\b(git|commit|branch|merge|pull|push|conflict|revert|history)\b/,
        type: 'git-issue',
        category: 'infrastructure',
        priority: 'low'
      },

      // DOCUMENTATION
      {
        pattern: /\b(documentation|docs|readme|comment|jsdoc|swagger|openapi)\b/,
        type: 'documentation',
        category: 'documentation',
        priority: 'low'
      }
    ];

    for (const rule of patterns) {
      if (rule.pattern.test(description)) {
        return {
          type: rule.type,
          category: rule.category,
          priority: rule.priority
        };
      }
    }

    return {
      type: 'general',
      category: 'unknown',
      priority: 'medium'
    };
  }

  /**
   * Identify affected areas
   */
  identifyAffectedAreas(description) {
    const areas = [];
    const desc = description.toLowerCase();

    // Layout areas
    if (/\b(navbar|nav bar|navigation|menu|header|top)\b/.test(desc)) areas.push('navigation');
    if (/\b(footer|bottom|copyright)\b/.test(desc)) areas.push('footer');
    if (/\b(sidebar|side menu|drawer)\b/.test(desc)) areas.push('sidebar');
    if (/\b(homepage|landing|hero|banner|main page)\b/.test(desc)) areas.push('homepage');
    if (/\b(about|about us|company|team)\b/.test(desc)) areas.push('about-page');
    if (/\b(contact|contact us|reach out)\b/.test(desc)) areas.push('contact-page');
    if (/\b(pricing|plan|subscription|payment|billing)\b/.test(desc)) areas.push('pricing-page');
    if (/\b(blog|article|post|news)\b/.test(desc)) areas.push('blog');
    if (/\b(product|service|feature|offering)\b/.test(desc)) areas.push('product-page');
    if (/\b(dashboard|admin|panel|backend interface)\b/.test(desc)) areas.push('dashboard');

    // UI components
    if (/\b(button|btn|click|cta|action)\b/.test(desc)) areas.push('buttons');
    if (/\b(link|href|anchor|url)\b/.test(desc)) areas.push('links');
    if (/\b(form|input|field|textbox|textarea|dropdown|select)\b/.test(desc)) areas.push('forms');
    if (/\b(modal|dialog|popup|overlay|lightbox)\b/.test(desc)) areas.push('modals');
    if (/\b(card|tile|box|container|wrapper)\b/.test(desc)) areas.push('cards');
    if (/\b(list|ul|ol|item|menu|dropdown)\b/.test(desc)) areas.push('lists');
    if (/\b(table|grid|row|column|cell)\b/.test(desc)) areas.push('tables');
    if (/\b(slider|carousel|slideshow|gallery)\b/.test(desc)) areas.push('sliders');
    if (/\b(tab|accordion|collapse|expand)\b/.test(desc)) areas.push('tabs');

    // Content types
    if (/\b(image|photo|picture|graphic|icon|logo|svg)\b/.test(desc)) areas.push('media');
    if (/\b(text|content|paragraph|copy|wording|label|heading|title)\b/.test(desc)) areas.push('content');
    if (/\b(video|audio|media|embed|iframe|youtube|vimeo)\b/.test(desc)) areas.push('embeds');
    if (/\b(map|location|address|directions)\b/.test(desc)) areas.push('maps');

    // Device/Platform
    if (/\b(mobile|phone|smartphone|ios|android)\b/.test(desc)) areas.push('mobile');
    if (/\b(tablet|ipad)\b/.test(desc)) areas.push('tablet');
    if (/\b(desktop|computer|laptop|pc|mac)\b/.test(desc)) areas.push('desktop');

    // Technical areas
    if (/\b(api|endpoint|backend|server)\b/.test(desc)) areas.push('api');
    if (/\b(database|db|data|storage|model)\b/.test(desc)) areas.push('database');
    if (/\b(auth|login|logout|session|security|permission)\b/.test(desc)) areas.push('authentication');
    if (/\b(config|setting|environment|env)\b/.test(desc)) areas.push('configuration');
    if (/\b(style|css|theme|color|font|typography)\b/.test(desc)) areas.push('styling');
    if (/\b(script|js|javascript|function|event)\b/.test(desc)) areas.push('javascript');
    if (/\b(seo|meta|search|google|sitemap)\b/.test(desc)) areas.push('seo');

    return areas.length > 0 ? areas : ['general'];
  }

  /**
   * Guess which files need modification
   */
  guessFiles(description) {
    const files = [];
    const desc = description.toLowerCase();
    const type = this.classifyIssue(desc);

    // Framework detection - React
    if (/\b(react|jsx|tsx|component|usestate|useeffect|props)\b/.test(desc)) {
      files.push('src/App.jsx', 'src/App.tsx', 'src/components/');
      if (/\b(navbar|nav|navigation|header)\b/.test(desc)) {
        files.push('src/components/Navbar.jsx', 'src/components/Header.jsx', 'src/components/Navigation.jsx');
      }
      if (/\b(button|btn)\b/.test(desc)) {
        files.push('src/components/Button.jsx', 'src/components/ui/Button.jsx');
      }
      if (/\b(footer)\b/.test(desc)) {
        files.push('src/components/Footer.jsx');
      }
      if (/\b(hero|banner)\b/.test(desc)) {
        files.push('src/components/Hero.jsx', 'src/sections/Hero.jsx');
      }
      if (/\b(card)\b/.test(desc)) {
        files.push('src/components/Card.jsx', 'src/components/ui/Card.jsx');
      }
      if (/\b(form|input|field)\b/.test(desc)) {
        files.push('src/components/Form.jsx', 'src/components/Input.jsx');
      }
      if (/\b(modal|dialog|popup)\b/.test(desc)) {
        files.push('src/components/Modal.jsx', 'src/components/Dialog.jsx');
      }
    }

    // Framework detection - Vue
    if (/\b(vue|vuejs|v-if|v-for|v-model|component)\b/.test(desc)) {
      files.push('src/App.vue', 'src/components/');
      if (/\b(navbar|nav|navigation|header)\b/.test(desc)) {
        files.push('src/components/Navbar.vue', 'src/components/Header.vue');
      }
      if (/\b(footer)\b/.test(desc)) {
        files.push('src/components/Footer.vue');
      }
    }

    // Framework detection - Svelte
    if (/\b(svelte|sveltekit)\b/.test(desc)) {
      files.push('src/App.svelte', 'src/routes/', 'src/lib/');
    }

    // Framework detection - Angular
    if (/\b(angular|ng-|component\.ts|module\.ts)\b/.test(desc)) {
      files.push('src/app/', 'src/app/app.component.ts', 'src/app/app.module.ts');
    }

    // HTML files for structure/content (fallback for non-framework)
    if (type.category === 'frontend' || type.category === 'content') {
      if (!files.some(f => f.includes('src/'))) {
        // Traditional/Vanilla JS project
        files.push('index.html', 'public/index.html');
      }
    }

    // CSS files - modern frameworks use CSS modules, styled-components, Tailwind
    if (type.type === 'css-styling' || type.category === 'frontend') {
      // Check for Tailwind
      if (/\b(tailwind|tailwindcss)\b/.test(desc)) {
        files.push('tailwind.config.js', 'tailwind.config.ts');
      }
      // Check for CSS modules
      if (/\b(module\.css|module\.scss)\b/.test(desc) || /\b(css module|scoped css)\b/.test(desc)) {
        files.push('src/components/*.module.css', 'src/styles/*.module.scss');
      }
      // Styled components
      if (/\b(styled|styled-components|css-in-js)\b/.test(desc)) {
        files.push('src/components/styles.js', 'src/styles/');
      }
      // Traditional CSS
      files.push('src/styles/', 'src/css/', 'styles/', 'css/');
      files.push('style.css', 'styles.css', 'main.css', 'app.css');
      files.push('style.unminified.css', 'styles.unminified.css');
      files.push('global.css', 'index.css');
    }

    // SCSS/Sass
    if (/\b(scss|sass)\b/.test(desc)) {
      files.push('src/styles/', 'styles/');
      files.push('style.scss', 'main.scss', 'app.scss');
    }

    // JS files for functionality
    if (type.type === 'functionality-bug' || /\b(javascript|js|function|click|event|handler)\b/.test(desc)) {
      // Modern projects
      files.push('src/utils/', 'src/hooks/', 'src/lib/');
      files.push('src/app.js', 'src/main.js', 'src/index.js');
      // Traditional projects
      files.push('script.js', 'scripts.js', 'main.js', 'app.js');
      files.push('script.unminified.js', 'app.unminified.js');
    }

    // Config files
    if (/\b(config|configuration|setting|env)\b/.test(desc)) {
      files.push('package.json', 'vite.config.js', 'webpack.config.js', 'rollup.config.js');
      files.push('.env', '.env.local', '.env.production', '.env.development');
      files.push('tsconfig.json', 'jsconfig.json');
    }

    // Assets
    if (/\b(image|photo|picture|logo|icon|asset)\b/.test(desc)) {
      files.push('public/', 'src/assets/', 'assets/', 'images/', 'img/');
      files.push('public/images/', 'src/assets/images/', 'static/images/');
    }

    // Simulator-specific
    if (/\b(simulator|demo|calculator)\b/.test(desc)) {
      files.push('simulator.html', 'simulator.js', 'simulator.css');
      files.push('src/components/Simulator.jsx', 'src/simulator/');
    }

    // Layout/Section specific
    if (/\b(layout|grid|container|wrapper)\b/.test(desc)) {
      files.push('src/layouts/', 'src/components/Layout.jsx', 'src/components/Container.jsx');
    }

    // Page/Router specific
    if (/\b(page|route|routing|router)\b/.test(desc)) {
      files.push('src/pages/', 'src/routes/', 'src/router/', 'src/views/');
      files.push('src/App.jsx', 'src/router/index.js');
    }

    return [...new Set(files)];
  }

  /**
   * Assess complexity
   */
  assessComplexity(description) {
    const desc = description.toLowerCase();

    // Simple: Adding links, changing colors, fixing alignment
    if (/\b(add|create)\b.*\b(link|button|menu item)\b/.test(desc)) return 'simple';
    if (/\b(fix|change)\b.*\b(color|align|spacing|margin|padding)\b/.test(desc)) return 'simple';
    if (/\b(update|change)\b.*\b(text|wording|label)\b/.test(desc)) return 'simple';

    // Medium: Component changes, minor functionality
    if (/\b(update|modify|improve)\b.*\b(component|section|layout)\b/.test(desc)) return 'medium';
    if (/\b(fix|repair)\b.*\b(function|behavior|interaction)\b/.test(desc)) return 'medium';

    // Complex: Refactoring, implementing features
    if (/\b(implement|build|create)\b.*\b(feature|functionality|system)\b/.test(desc)) return 'complex';
    if (/\b(refactor|restructure|redesign)\b/.test(desc)) return 'complex';

    return 'medium';
  }

  /**
   * Determine required actions
   */
  determineActions(description) {
    const actions = [];
    const desc = description.toLowerCase();

    if (/\b(add|create|implement)\b/.test(desc)) actions.push('create');
    if (/\b(remove|delete|eliminate)\b/.test(desc)) actions.push('delete');
    if (/\b(update|change|modify|edit)\b/.test(desc)) actions.push('modify');
    if (/\b(fix|repair|resolve|correct)\b/.test(desc)) actions.push('fix');
    if (/\b(style|css|color|font|align)\b/.test(desc)) actions.push('style');

    return actions.length > 0 ? actions : ['modify'];
  }

  /**
   * Detect technology stack
   */
  detectTechStack(description) {
    const desc = description.toLowerCase();
    const stack = [];

    if (/\b(html|structure|element|tag)\b/.test(desc)) stack.push('html');
    if (/\b(css|style)\b/.test(desc)) stack.push('css');
    if (/\b(scss|sass)\b/.test(desc)) stack.push('scss');
    if (/\b(tailwind|tailwindcss)\b/.test(desc)) stack.push('tailwindcss');
    if (/\b(bootstrap)\b/.test(desc)) stack.push('bootstrap');
    if (/\b(javascript|js)\b/.test(desc)) stack.push('javascript');
    if (/\b(typescript|ts|\.ts)\b/.test(desc)) stack.push('typescript');
    if (/\b(react|jsx|tsx|usestate|useeffect|hooks)\b/.test(desc)) stack.push('react');
    if (/\b(vue|vuejs)\b/.test(desc)) stack.push('vue');
    if (/\b(svelte|sveltekit)\b/.test(desc)) stack.push('svelte');
    if (/\b(angular)\b/.test(desc)) stack.push('angular');
    if (/\b(next\.js|nextjs)\b/.test(desc)) stack.push('nextjs');
    if (/\b(nuxt\.js|nuxtjs)\b/.test(desc)) stack.push('nuxtjs');
    if (/\b(node|nodejs|express)\b/.test(desc)) stack.push('nodejs');
    if (/\b(vite)\b/.test(desc)) stack.push('vite');
    if (/\b(webpack)\b/.test(desc)) stack.push('webpack');
    if (/\b(styled-components|styled components)\b/.test(desc)) stack.push('styled-components');

    return stack.length > 0 ? stack : ['html', 'css', 'javascript'];
  }

  /**
   * Extract keywords
   */
  extractKeywords(description) {
    // Extract important technical terms
    const matches = description.match(/\b[a-zA-Z]+(?:[-_][a-zA-Z]+)*\b/g) || [];

    // Extended list of technical terms including modern frameworks
    const technicalTerms = [
      // Layout/UI elements
      'navbar', 'header', 'footer', 'button', 'link', 'menu', 'nav', 'hero', 'banner',
      'card', 'modal', 'dialog', 'popup', 'form', 'input', 'field', 'select',
      'container', 'wrapper', 'section', 'main', 'sidebar', 'content',
      // CSS properties
      'color', 'background', 'font', 'text', 'align', 'margin', 'padding',
      'width', 'height', 'display', 'position', 'flex', 'grid', 'border', 'shadow',
      'spacing', 'gap', 'radius', 'opacity', 'z-index', 'overflow',
      // JavaScript/React terms
      'click', 'function', 'event', 'handler', 'listener', 'state', 'props',
      'component', 'hook', 'effect', 'ref', 'context', 'render',
      // Frameworks
      'react', 'vue', 'svelte', 'angular', 'jsx', 'tsx',
      // File types
      'class', 'id', 'css', 'scss', 'sass', 'html', 'javascript', 'typescript',
      'module', 'styled', 'tailwind', 'bootstrap',
      // Actions
      'fix', 'add', 'remove', 'update', 'change', 'create', 'modify', 'style'
    ];

    const foundTerms = matches.filter(word =>
      technicalTerms.includes(word.toLowerCase())
    );

    return [...new Set(foundTerms.map(w => w.toLowerCase()))];
  }

  /**
   * Calculate confidence score
   */
  calculateConfidence(description) {
    let score = 0.5; // Base confidence

    // Increase for clear patterns
    if (/\b(add|create|fix|update|remove)\b/.test(description.toLowerCase())) score += 0.2;
    if (/\b(css|html|javascript|style)\b/.test(description.toLowerCase())) score += 0.15;
    if (/\b(in|on|to|from)\b/.test(description.toLowerCase())) score += 0.1;

    // Decrease for ambiguity
    if (description.length < 10) score -= 0.2;
    if (/\b(something|somehow|maybe|perhaps)\b/.test(description.toLowerCase())) score -= 0.15;

    return Math.min(Math.max(score, 0), 1);
  }

  /**
   * Step 2: Build the prompt
   */
  buildPrompt(ticket, context) {
    const sections = [];

    // Header
    sections.push(`🎫 AUTOBUG TICKET #${ticket.id}`);
    sections.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    // Original request
    sections.push(`📋 ORIGINAL REQUEST:`);
    sections.push(`   "${ticket.description}"\n`);

    // Context analysis
    sections.push(`🔍 CONTEXT ANALYSIS:`);
    sections.push(`   • Issue Type: ${context.issueType.type} (${context.issueType.category})`);
    sections.push(`   • Priority: ${context.issueType.priority}`);
    sections.push(`   • Complexity: ${context.complexity}`);
    sections.push(`   • Confidence: ${Math.round(context.confidence * 100)}%`);
    sections.push(`   • Affected Areas: ${context.affectedAreas.join(', ')}`);
    sections.push(`   • Actions Required: ${context.actions.join(', ')}`);
    sections.push(`   • Tech Stack: ${context.techStack.join(', ')}`);
    sections.push(`   • Keywords: ${context.keywords.join(', ')}\n`);

    // Target files
    sections.push(`📂 LIKELY FILES TO MODIFY:`);
    context.likelyFiles.forEach(file => {
      sections.push(`   • ${this.sshConfig.repoPath}/${file}`);
    });
    sections.push('');

    // Server info
    sections.push(`🖥️  TARGET SERVER:`);
    sections.push(`   • Host: ${this.sshConfig.user}@${this.sshConfig.host}`);
    sections.push(`   • Repo: ${this.sshConfig.repoPath}\n`);

    // Instructions
    sections.push(`🎯 YOUR TASK:`);
    sections.push(this.generateInstructions(context));
    sections.push('');

    // Steps
    sections.push(`📋 EXECUTION STEPS:`);
    this.generateSteps(context).forEach((step, i) => {
      sections.push(`   ${i + 1}. ${step}`);
    });
    sections.push('');

    // Safety notes
    sections.push(`⚠️  IMPORTANT NOTES:`);
    sections.push(`   • Make minimal changes - only what's needed`);
    sections.push(`   • Follow existing code patterns and style`);
    sections.push(`   • Test if possible before finishing`);
    sections.push(`   • Preserve existing functionality`);
    sections.push(`   • Use existing CSS classes if available\n`);

    return sections.join('\n');
  }

  /**
   * Generate specific instructions based on context
   */
  generateInstructions(context) {
    const desc = context.originalDescription || '';

    switch(context.issueType.type) {
      case 'content-addition':
        return `   Add the requested content element exactly as specified.
   Maintain consistency with existing UI patterns and styling.
   Ensure proper placement within the existing structure.`;

      case 'css-styling':
        return `   Fix the styling issue while maintaining responsive design.
   Use existing CSS classes where possible.
   Ensure the fix works across different screen sizes.`;

      case 'functionality-bug':
        return `   Identify and fix the broken functionality.
   Check for JavaScript errors and event handling issues.
   Ensure the fix doesn't break other features.`;

      case 'content-update':
        return `   Update the text/content as requested.
   Maintain the same tone and style as surrounding content.
   Ensure no formatting is broken.`;

      default:
        return `   Analyze the codebase to understand the issue.
   Implement a clean, minimal fix.
   Ensure code quality and consistency.`;
    }
  }

  /**
   * Generate execution steps
   */
  generateSteps(context) {
    const steps = [
      'SSH into the server',
      `Navigate to ${this.sshConfig.repoPath}`,
      'Read relevant source files'
    ];

    // Add context-specific steps
    if (context.issueType.type === 'css-styling') {
      steps.push('Identify CSS selectors and rules');
      steps.push('Apply styling fixes');
    }

    if (context.issueType.type === 'content-addition') {
      steps.push('Locate insertion point');
      steps.push('Add new content following existing patterns');
    }

    steps.push('Verify the changes');
    steps.push('Save and commit if possible');
    steps.push('Report completion');

    return steps;
  }

  /**
   * Step 3: Create execution plan
   */
  createExecutionPlan(context) {
    return {
      autoExecute: true,
      requireConfirmation: context.complexity === 'complex',
      dryRun: false,
      timeout: context.complexity === 'simple' ? 120000 : 300000,
      retryOnFailure: true,
      maxRetries: 2
    };
  }
}

// Export for use
module.exports = { PromptGenerator };

// CLI usage
if (require.main === module) {
  const generator = new PromptGenerator();

  // If run with a ticket file
  const ticketFile = process.argv[2];
  if (ticketFile) {
    const ticket = JSON.parse(fs.readFileSync(ticketFile, 'utf8'));
    const result = generator.generate(ticket);
    console.log(result.prompt);
    console.log('\n🔧 AUTO-EXECUTE:', result.executionPlan.autoExecute);
  } else {
    // Test with sample ticket
    const testTicket = {
      id: 'test-123',
      description: 'Add blogs link to the navbar',
      targetRepoUrl: '/var/www/adelphos_frontend'
    };
    const result = generator.generate(testTicket);
    console.log(result.prompt);
  }
}
