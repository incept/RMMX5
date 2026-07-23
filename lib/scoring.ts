import { createAdminClient } from '@/lib/supabase/server';

/**
 * Scoring engine.
 *
 * REPUTATION SCORE (0–100) — ported from the ContextAI / Reputation Monitor
 * project. Two ingredients:
 *
 *   1. Link Score: every LIVE tracked link is matched against the admin's
 *      `url_rules`. A matched rule contributes its `score_weight`; a live
 *      link on an unlisted site contributes DEFAULT_LINK_WEIGHT. Requested/
 *      removed links contribute nothing — removals directly raise the score.
 *   2. Sentiment: the same lexicon scorer ContextAI used for search results,
 *      applied to whatever text we have for a link/result (title + snippet
 *      from the auto Google search). Negative sentiment adds a small penalty
 *      on top of the rule weight.
 *
 *   reputation = clamp(100 - linkScore - sentimentPenalty, 0, 100)
 *
 * Admins tune everything from Admin → URL Rules (weight, difficulty, price).
 */

const POSITIVE_WORDS = [
  'best', 'great', 'excellent', 'amazing', 'love', 'positive', 'good',
  'trusted', 'top', 'award', 'success', 'recommend', 'reliable', 'outstanding',
  'praise', 'innovative', 'leading', 'wonderful', 'impressive', 'happy',
];

const NEGATIVE_WORDS = [
  'scam', 'fraud', 'lawsuit', 'complaint', 'bad', 'worst', 'terrible',
  'negative', 'fail', 'failure', 'issue', 'problem', 'sued', 'sue',
  'investigation', 'fired', 'controversy', 'boycott', 'warning', 'danger',
  'hate', 'poor', 'disappointing', 'breach', 'hack', 'hacked', 'recall',
  'arrest', 'arrested', 'mugshot', 'charged', 'convicted',
];

export type Sentiment = 'positive' | 'neutral' | 'negative';

export function scoreSentiment(title: string, snippet: string): Sentiment {
  const text = `${title} ${snippet}`.toLowerCase();
  let score = 0;
  for (const w of POSITIVE_WORDS) if (text.includes(w)) score += 1;
  for (const w of NEGATIVE_WORDS) if (text.includes(w)) score -= 1;
  if (score > 0) return 'positive';
  if (score < 0) return 'negative';
  return 'neutral';
}

const DEFAULT_LINK_WEIGHT = 10; // live link on a site with no configured rule
const NEGATIVE_SENTIMENT_PENALTY = 5;

export interface UrlRule {
  id: string;
  pattern: string;
  difficulty: number;
  score_weight: number;
  removal_price: number;
  relevant: boolean;
}

export interface LinkLike {
  url: string;
  status: 'live' | 'requested' | 'removed';
  title?: string;
  snippet?: string;
}

/** Case-insensitive substring match of a rule pattern against a URL. */
export function matchUrlRule<T extends UrlRule>(url: string, rules: T[]): T | null {
  const normalized = url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  for (const rule of rules) {
    const pattern = rule.pattern.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
    if (pattern && normalized.includes(pattern)) return rule;
  }
  return null;
}

export function computeLinkScore(links: LinkLike[], rules: UrlRule[]): number {
  let total = 0;
  for (const link of links) {
    if (!link.url || link.status !== 'live') continue;
    const rule = matchUrlRule(link.url, rules);
    total += rule ? Number(rule.score_weight) : DEFAULT_LINK_WEIGHT;
    if (scoreSentiment(link.title ?? '', link.snippet ?? '') === 'negative') {
      total += NEGATIVE_SENTIMENT_PENALTY;
    }
  }
  return Math.round(total * 100) / 100;
}

export function computeReputationScore(linkScore: number): number {
  return Math.max(0, Math.min(100, Math.round((100 - linkScore) * 10) / 10));
}

/**
 * Projected revenue for a contact = sum of removal prices for every LIVE link
 * that matches a priced url_rule. That is exactly "what we could charge this
 * client to clean up what's currently out there".
 */
export function computeRevenueProjection(links: LinkLike[], rules: UrlRule[]): number {
  let total = 0;
  for (const link of links) {
    if (!link.url || link.status !== 'live') continue;
    const rule = matchUrlRule(link.url, rules);
    if (rule) total += Number(rule.removal_price);
  }
  return Math.round(total * 100) / 100;
}

/**
 * Recomputes and persists reputation_score, link_score, revenue_projection
 * for one contact, and stamps each link with its matched rule/difficulty.
 * Call after any link edit, import, or auto-search.
 */
export async function applyScores(contactId: string) {
  const supabase = createAdminClient();

  const [{ data: links }, { data: rules }] = await Promise.all([
    supabase.from('contact_links').select('*').eq('contact_id', contactId),
    supabase.from('url_rules').select('*'),
  ]);

  const linkRows = (links ?? []) as any[];
  const ruleRows = (rules ?? []) as UrlRule[];

  // Stamp each link with its matched rule (id, difficulty, weight) so the UI
  // can show per-link difficulty without re-matching client-side.
  for (const link of linkRows) {
    if (!link.url) continue;
    const rule = matchUrlRule(link.url, ruleRows);
    const patch = {
      url_rule_id: rule?.id ?? null,
      difficulty: rule?.difficulty ?? null,
      score_weight: rule ? rule.score_weight : DEFAULT_LINK_WEIGHT,
    };
    if (
      patch.url_rule_id !== link.url_rule_id ||
      patch.difficulty !== link.difficulty ||
      Number(patch.score_weight) !== Number(link.score_weight)
    ) {
      await supabase.from('contact_links').update(patch).eq('id', link.id);
    }
  }

  const linkScore = computeLinkScore(linkRows, ruleRows);
  const reputation = computeReputationScore(linkScore);
  const revenue = computeRevenueProjection(linkRows, ruleRows);

  await supabase
    .from('contacts')
    .update({ link_score: linkScore, reputation_score: reputation, revenue_projection: revenue })
    .eq('id', contactId);

  return { linkScore, reputation, revenue };
}
