import { describe, expect, it } from 'vitest';
import {
  AUTOPILOT_MODEL_SEEDS,
  chooseModel,
  matchModelName,
  mergeCatalog,
  normalizeModelName,
  scoreModelName,
  tierForScore,
  type ModelCatalogEntry,
} from '../shared/autopilot';

describe('normalizeModelName', () => {
  it('folds width, case, spacing and separators', () => {
    expect(normalizeModelName('ＧＬＭ－５.３－Ｆｌａｓｈ')).toBe('glm-5.3-flash');
    expect(normalizeModelName('  GLM  5.3  Flash ')).toBe('glm5.3flash');
    expect(normalizeModelName('glm_5.3_flash')).toBe('glm-5.3-flash');
    expect(normalizeModelName('GLM-5.3-Flash（中国）')).toBe('glm-5.3-flash');
  });
});

describe('scoreModelName', () => {
  it('scores exact and alias-level matches at 100', () => {
    expect(scoreModelName('GLM-5.3-Flash', 'glm-5.3-flash')).toBe(100);
    expect(scoreModelName('GLM-5.3-Flash（中国）', 'GLM-5.3-Flash')).toBe(100);
  });

  it('scores decorated labels at 80', () => {
    expect(scoreModelName('GLM-5.3-Flash 视觉', 'GLM-5.3-Flash')).toBe(80);
    expect(scoreModelName('思考强度 最高', '思考强度')).toBeGreaterThanOrEqual(80);
  });

  it('scores token overlap at 55', () => {
    expect(scoreModelName('GLM 5.3 Flash', 'GLM-5.3-Flash')).toBe(55);
    expect(scoreModelName('Start Plan 免费', 'Start Plan')).toBeGreaterThanOrEqual(80);
  });

  it('scores near-misses weakly and unrelated names at 0', () => {
    expect(scoreModelName('GLM-5.4-Flash', 'GLM-5.3-Flash')).toBe(30);
    expect(scoreModelName('GLM-5.3-Flas', 'GLM-5.3-Flash')).toBe(80);
    expect(scoreModelName('DeepSeek-V3', 'GLM-5.3-Flash')).toBe(0);
    expect(scoreModelName('', 'x')).toBe(0);
  });
});

describe('tierForScore', () => {
  it('maps score bands', () => {
    expect(tierForScore(100)).toBe('exact');
    expect(tierForScore(80)).toBe('prefix');
    expect(tierForScore(55)).toBe('fuzzy');
    expect(tierForScore(30)).toBe('weak');
    expect(tierForScore(0)).toBe('none');
  });
});

describe('matchModelName', () => {
  const items = ['GLM-5.3-Flash 视觉', 'GLM-5.3', 'GLM-5.3-FlashX', 'Qwen3-Coder'];

  it('prefers the exact entry over decorated ones', () => {
    const match = matchModelName(items, 'GLM-5.3-Flash', (item) => item);
    expect(match?.value).toBe('GLM-5.3-Flash 视觉');
    expect(match?.score).toBe(80);
  });

  it('uses aliases', () => {
    const catalog: ModelCatalogEntry[] = [
      { provider: 'P', name: 'GLM-5.3-Flash', aliases: ['glm-5.3-flash'], source: 'seed' },
    ];
    const match = matchModelName(catalog, 'glm-5.3-flash', (e) => e.name, (e) => e.aliases ?? []);
    expect(match?.score).toBe(100);
  });

  it('returns null when nothing scores', () => {
    expect(matchModelName(items, 'Nothing-Here', (item) => item)).toBeNull();
  });
});

describe('chooseModel', () => {
  it('accepts a clear winner without confirmation', () => {
    const choice = chooseModel(AUTOPILOT_MODEL_SEEDS, 'GLM-5.3-Flash', (e) => e.name, (e) => e.aliases ?? []);
    expect(choice).not.toBeNull();
    expect(choice!.score).toBe(100);
    expect(choice!.needsConfirmation).toBe(true); // two providers advertise it
  });

  it('rejects a tie even at a high score', () => {
    const items = ['Model A 视觉', 'Model A 思考'];
    expect(chooseModel(items, 'Model A', (item) => item)).toBeNull();
  });

  it('requires confirmation for a unique fuzzy match', () => {
    const choice = chooseModel(['GLM 5.3 Flash', 'Qwen3-Max'], 'GLM-5.3-Flash', (item) => item);
    expect(choice?.score).toBe(55);
    expect(choice?.needsConfirmation).toBe(true);
  });

  it('rejects ambiguous fuzzy matches', () => {
    const choice = chooseModel(['GLM 5.3 Flash', 'GLM-5.3 Flash'], 'GLM-5.3-Flash', (item) => item);
    expect(choice).toBeNull();
  });

  it('rejects weak-only matches', () => {
    expect(chooseModel(['GLM-5.4-Flash'], 'GLM-5.3-Flash', (item) => item)).toBeNull();
    expect(chooseModel([], 'x', (item: string) => item)).toBeNull();
  });
});

describe('mergeCatalog', () => {
  const seed: ModelCatalogEntry = { provider: 'Start Plan', name: 'GLM-5.3-Flash', source: 'seed', contextWindow: 1000 };
  const observed: ModelCatalogEntry = {
    provider: 'Start Plan',
    name: 'GLM-5.3-Flash',
    source: 'observed',
    vision: true,
    observedAt: '2026-11-01T00:00:00.000Z',
  };
  const remote: ModelCatalogEntry = { provider: 'start plan', name: 'glm-5.3-flash', source: 'remote', contextWindow: 2 };

  it('lets observations win over seeds and remote data', () => {
    const merged = mergeCatalog([seed, remote, observed]);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('observed');
    expect(merged[0].vision).toBe(true);
  });

  it('keeps distinct providers and sorts deterministically', () => {
    const merged = mergeCatalog([
      { provider: 'Z.ai', name: 'GLM-5.3-Flash', source: 'seed' },
      seed,
      { provider: '阿里云百炼（中国）', name: 'Qwen3-Max', source: 'seed' },
    ]);
    expect(merged).toHaveLength(3);
    expect(merged.map((entry) => entry.name)).toEqual(['GLM-5.3-Flash', 'GLM-5.3-Flash', 'Qwen3-Max']);
  });

  it('seeds cover the documented ZCode families', () => {
    const names = new Set(AUTOPILOT_MODEL_SEEDS.map((entry) => entry.name));
    for (const expected of ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.3-FlashX', 'GLM-5.2', 'Qwen3-Coder']) {
      expect(names.has(expected)).toBe(true);
    }
    const flash = AUTOPILOT_MODEL_SEEDS.find((entry) => entry.name === 'GLM-5.3-Flash')!;
    expect(flash.contextWindow).toBe(1_000_000);
    expect(flash.vision).toBe(true);
    expect(flash.thinkingLevels).toEqual(['low', 'medium', 'high', 'max']);
  });
});
