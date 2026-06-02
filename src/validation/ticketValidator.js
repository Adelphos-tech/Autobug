#!/usr/bin/env node
/**
 * Ticket Validator
 * Ensures only safe, well-understood tickets are processed automatically
 */

class TicketValidator {
  constructor() {
    // Minimum confidence threshold for auto-processing (0.0 - 1.0)
    this.MIN_CONFIDENCE = 0.7;

    // Maximum complexity allowed for auto-processing
    this.MAX_COMPLEXITY = 'medium';

    // Complexities ranked
    this.complexityRank = {
      'simple': 1,
      'medium': 2,
      'complex': 3
    };

    // Keywords that trigger manual review (not rejection)
    // These are complex areas that need human oversight
    this.REVIEW_KEYWORDS = [
      'production', 'prod', 'live', 'critical',
      'password', 'token', 'secret', 'key',
      'drop table', 'drop database', 'delete all', 'remove all',
      'refactor', 'rewrite', 'restructure'
    ];

    // Dangerous keywords that block auto-processing
    this.FORBIDDEN_KEYWORDS = [
      'rm -rf', 'format', 'destroy'
    ];

    // Required keywords for valid tickets
    this.REQUIRED_PATTERNS = [
      /\b(add|create|fix|update|change|remove|implement)\b/i,
      /\b(in|on|to|from|for)\b/i
    ];

    // Safe issue types for auto-processing
    // All types are potentially safe - complexity and confidence determine auto vs manual
    this.SAFE_ISSUE_TYPES = [
      // Content operations (low risk)
      'content-addition',
      'content-update',
      'content-removal',
      'content-management',

      // Frontend (medium risk - depends on specificity)
      'css-styling',
      'functionality-bug',
      'javascript-issue',
      'form-issue',
      'image-update',
      'accessibility',
      'seo-issue',
      'routing-issue',

      // Backend (high risk - manual review)
      'backend-issue',
      'api-issue',
      'database-issue',
      'deployment-issue',

      // Infrastructure
      'config-issue',
      'dependency-issue',
      'docker-issue',
      'cicd-issue',
      'git-issue',

      // Security (critical - manual review)
      'security-issue',

      // Performance
      'performance',

      // Testing
      'testing-issue',

      // Documentation
      'documentation',

      // Generic
      'minor-fix',
      'general',
      'unknown'
    ];
  }

  /**
   * Main validation entry point
   * Returns validation result with detailed reasoning
   */
  validate(ticket, context) {
    const results = {
      ticketId: ticket.id,
      isValid: true,
      canAutoProcess: false,
      requiresManualReview: false,
      warnings: [],
      errors: [],
      checks: {}
    };

    // Run all validation checks
    const checks = [
      this.checkDescriptionQuality(ticket.description),
      this.checkForbiddenKeywords(ticket.description),
      this.checkConfidenceLevel(context.confidence),
      this.checkComplexity(context.complexity),
      this.checkIssueType(context.issueType?.type),
      this.checkTargetFiles(context.likelyFiles),
      this.checkRepositoryAccess(ticket.targetRepoUrl),
      this.checkSafetyPatterns(ticket.description)
    ];

    // Aggregate results
    for (const check of checks) {
      results.checks[check.name] = check;

      if (!check.passed) {
        results.isValid = false;
        results.errors.push(...check.errors);
      }

      if (check.warnings) {
        results.warnings.push(...check.warnings);
      }
    }

    // Determine if can auto-process
    results.canAutoProcess = this.canAutoProcess(results);
    results.requiresManualReview = !results.canAutoProcess;

    // Generate recommendation
    results.recommendation = this.generateRecommendation(results);

    return results;
  }

  /**
   * Check 1: Description Quality
   */
  checkDescriptionQuality(description) {
    const result = {
      name: 'descriptionQuality',
      passed: true,
      errors: [],
      warnings: []
    };

    if (!description || description.trim().length === 0) {
      result.passed = false;
      result.errors.push('Description is empty');
      return result;
    }

    const trimmed = description.trim();

    // Check minimum length
    if (trimmed.length < 10) {
      result.warnings.push(`Description short (${trimmed.length} chars) - may need clarification`);
    }

    // Check maximum length (too long might be unclear)
    if (trimmed.length > 500) {
      result.warnings.push(`Description very long (${trimmed.length} chars). Consider being more specific`);
    }

    // Check for vague terms
    const vagueTerms = ['something', 'somehow', 'somewhere', 'thing', 'stuff'];
    const foundVague = vagueTerms.filter(term =>
      trimmed.toLowerCase().includes(term)
    );

    if (foundVague.length > 0) {
      result.warnings.push(`Description contains vague terms: ${foundVague.join(', ')}`);
    }

    // Note: Users don't need to know technical terms
    // The system should analyze images and codebase to locate issues
    // No warning needed for non-technical language

    return result;
  }

  /**
   * Check 2: Forbidden Keywords
   */
  checkForbiddenKeywords(description) {
    const result = {
      name: 'forbiddenKeywords',
      passed: true,
      errors: [],
      warnings: []
    };

    const lowerDesc = description.toLowerCase();

    // Check for dangerous forbidden keywords (blocks processing)
    const foundForbidden = this.FORBIDDEN_KEYWORDS.filter(keyword =>
      lowerDesc.includes(keyword.toLowerCase())
    );

    if (foundForbidden.length > 0) {
      result.passed = false;
      result.errors.push(
        `Contains dangerous keywords: ${foundForbidden.join(', ')}`
      );
    }

    // Check for review keywords (warns but doesn't block)
    const foundReview = this.REVIEW_KEYWORDS.filter(keyword =>
      lowerDesc.includes(keyword.toLowerCase())
    );

    if (foundReview.length > 0) {
      result.warnings.push(
        `Contains sensitive keywords requiring review: ${foundReview.join(', ')}`
      );
    }

    return result;
  }

  /**
   * Check 3: Confidence Level
   */
  checkConfidenceLevel(confidence) {
    const result = {
      name: 'confidenceLevel',
      passed: true,
      errors: [],
      warnings: []
    };

    if (confidence === undefined || confidence === null) {
      result.passed = false;
      result.errors.push('No confidence score provided');
      return result;
    }

    const score = parseFloat(confidence);

    if (isNaN(score)) {
      result.passed = false;
      result.errors.push('Invalid confidence score');
      return result;
    }

    if (score < this.MIN_CONFIDENCE) {
      // Low confidence - warn instead of fail so it goes to manual review
      result.warnings.push(
        `Confidence low (${(score * 100).toFixed(0)}%). Manual review recommended`
      );
    } else if (score < 0.85) {
      result.warnings.push(
        `Confidence moderate (${(score * 100).toFixed(0)}%). Review recommended`
      );
    }

    return result;
  }

  /**
   * Check 4: Complexity Level
   */
  checkComplexity(complexity) {
    const result = {
      name: 'complexity',
      passed: true,
      errors: [],
      warnings: []
    };

    if (!complexity) {
      result.passed = false;
      result.errors.push('Complexity not assessed');
      return result;
    }

    const ticketRank = this.complexityRank[complexity] || 2;
    const maxRank = this.complexityRank[this.MAX_COMPLEXITY];

    if (ticketRank > maxRank) {
      result.passed = false;
      result.errors.push(
        `Complexity too high: ${complexity}. ` +
        `Maximum for auto: ${this.MAX_COMPLEXITY}`
      );
    }

    return result;
  }

  /**
   * Check 5: Issue Type Safety
   */
  checkIssueType(issueType) {
    const result = {
      name: 'issueType',
      passed: true,
      errors: [],
      warnings: []
    };

    if (!issueType) {
      result.passed = false;
      result.errors.push('Issue type not determined');
      return result;
    }

    if (!this.SAFE_ISSUE_TYPES.includes(issueType)) {
      result.passed = false;
      result.errors.push(
        `Issue type "${issueType}" requires manual review. ` +
        `Safe types: ${this.SAFE_ISSUE_TYPES.join(', ')}`
      );
    }

    return result;
  }

  /**
   * Check 6: Target Files
   */
  checkTargetFiles(files) {
    const result = {
      name: 'targetFiles',
      passed: true,
      errors: [],
      warnings: []
    };

    if (!files || files.length === 0) {
      // No target files - warn instead of fail so it goes to manual review
      result.warnings.push('No target files automatically identified');
      return result;
    }

    // Check for suspicious file patterns
    const dangerousPatterns = [
      /\.(sql|db|sqlite)$/i,
      /config\.js$/i,
      /\.env/i,
      /package\.json$/i
    ];

    const dangerousFiles = files.filter(file =>
      dangerousPatterns.some(pattern => pattern.test(file))
    );

    if (dangerousFiles.length > 0) {
      result.passed = false;
      result.errors.push(
        `Target includes sensitive files: ${dangerousFiles.join(', ')}`
      );
    }

    // Warn if many files
    if (files.length > 5) {
      result.warnings.push(
        `Many files targeted (${files.length}). Scope may be too broad`
      );
    }

    return result;
  }

  /**
   * Check 7: Repository Access
   */
  checkRepositoryAccess(repoUrl) {
    const result = {
      name: 'repositoryAccess',
      passed: true,
      errors: [],
      warnings: []
    };

    if (!repoUrl) {
      result.passed = false;
      result.errors.push('No target repository specified');
      return result;
    }

    // Check if it's a known safe repo
    const safeRepos = [
      '/var/www/adelphos_frontend',
      'adelphos_frontend'
    ];

    const isSafe = safeRepos.some(safe => repoUrl.includes(safe));

    if (!isSafe) {
      result.warnings.push(
        `Repository "${repoUrl}" not in whitelist. Verify before proceeding`
      );
    }

    return result;
  }

  /**
   * Check 8: Safety Patterns
   */
  checkSafetyPatterns(description) {
    const result = {
      name: 'safetyPatterns',
      passed: true,
      errors: [],
      warnings: []
    };

    const lowerDesc = description.toLowerCase();

    // Check for destructive operations
    // These are DANGEROUS patterns that should always be blocked
    const destructivePatterns = [
      { pattern: /\bdelete\s+all\b/i, msg: 'Mass deletion command detected' },
      { pattern: /\bremove\s+all\b/i, msg: 'Mass removal command detected' },
      { pattern: /\bclear\s+all\b/i, msg: 'Mass clearing command detected' },
      { pattern: /\bdrop\s+(table|database)\b/i, msg: 'Database destruction detected' },
      { pattern: /\brm\s+-rf\b/i, msg: 'Recursive force deletion detected' },
      { pattern: /\bdestroy\s+all\b/i, msg: 'Mass destruction detected' }
    ];

    for (const { pattern, msg } of destructivePatterns) {
      if (pattern.test(lowerDesc)) {
        result.passed = false;
        result.errors.push(msg);
      }
    }

    // Check for missing context
    const ambiguousPatterns = [
      { pattern: /^\s*fix\s*$/i, msg: 'Too vague: just says "fix"' },
      { pattern: /^\s*update\s*$/i, msg: 'Too vague: just says "update"' },
      { pattern: /^\s*change\s*$/i, msg: 'Too vague: just says "change"' }
    ];

    for (const { pattern, msg } of ambiguousPatterns) {
      if (pattern.test(description.trim())) {
        result.passed = false;
        result.errors.push(msg);
      }
    }

    return result;
  }

  /**
   * Determine if ticket can be auto-processed
   */
  canAutoProcess(results) {
    // Must be valid
    if (!results.isValid) return false;

    // No errors allowed
    if (results.errors.length > 0) return false;

    // Warnings are OK but log them
    return true;
  }

  /**
   * Generate human-readable recommendation
   */
  generateRecommendation(results) {
    if (!results.isValid) {
      return {
        action: 'REJECT',
        message: 'Ticket failed validation. Please fix errors before proceeding.',
        errors: results.errors
      };
    }

    if (results.requiresManualReview) {
      return {
        action: 'MANUAL_REVIEW',
        message: 'Ticket requires manual review due to warnings or uncertain context.',
        warnings: results.warnings
      };
    }

    if (results.canAutoProcess) {
      return {
        action: 'AUTO_PROCESS',
        message: 'Ticket is safe for automatic processing.',
        warnings: results.warnings.length > 0 ? results.warnings : undefined
      };
    }

    return {
      action: 'UNKNOWN',
      message: 'Unable to determine processing path. Manual review required.'
    };
  }

  /**
   * Quick check - returns boolean
   */
  isSafeToProcess(ticket, context) {
    const result = this.validate(ticket, context);
    return result.canAutoProcess;
  }
}

module.exports = { TicketValidator };

// CLI usage
if (require.main === module) {
  const validator = new TicketValidator();

  // Test examples
  const testCases = [
    {
      description: 'Add pricing link to navbar',
      confidence: 0.8,
      complexity: 'simple',
      issueType: 'content-addition',
      files: ['index.html']
    },
    {
      description: 'Fix database connection',
      confidence: 0.6,
      complexity: 'complex',
      issueType: 'backend-issue',
      files: ['config.js']
    },
    {
      description: '',
      confidence: 0,
      complexity: null,
      issueType: null,
      files: []
    }
  ];

  console.log('Ticket Validator Test Results:\n');

  testCases.forEach((test, i) => {
    console.log(`Test ${i + 1}: "${test.description || '(empty)'}"`);
    const ticket = { id: `test-${i}`, description: test.description };
    const context = test;
    const result = validator.validate(ticket, context);

    console.log('  Valid:', result.isValid);
    console.log('  Auto-process:', result.canAutoProcess);
    console.log('  Action:', result.recommendation.action);
    console.log('  Errors:', result.errors.length > 0 ? result.errors : 'None');
    console.log('  Warnings:', result.warnings.length > 0 ? result.warnings : 'None');
    console.log('');
  });
}
