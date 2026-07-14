import { register } from '../router.js';
import * as core from '../../core/orderflow.js';

register('vp', {
  description: 'Volume profile / order flow (read, add, remove)',
  subcommands: new Map([
    ['read', {
      description: 'Read volume-at-price rows (buy/sell split, POC, value area) from volume profile studies',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter by study name substring (e.g. "Session")' },
        rows: { type: 'string', short: 'n', description: 'Max rows per profile (highest price first)' },
      },
      handler: (opts) => core.getVolumeProfile({
        study_filter: opts.filter,
        max_rows: opts.rows ? Number(opts.rows) : undefined,
      }),
    }],
    ['orderflow', {
      description: 'Read per-candle order flow (footprint): buy/sell volume per price level, imbalances, POC/VA, delta',
      options: {
        count: { type: 'string', short: 'n', description: 'Most-recent candles to return (default 10, cap 100)' },
        summary: { type: 'boolean', short: 's', description: 'Per-candle totals without price levels' },
      },
      handler: (opts) => core.getOrderFlow({
        count: opts.count ? Number(opts.count) : undefined,
        summary: opts.summary,
      }),
    }],
    ['add', {
      description: `Add a volume profile study. Types: ${Object.keys(core.VOLUME_PROFILE_TYPES).join(', ')}`,
      options: {
        type: { type: 'string', short: 't', description: 'Profile type (default visible_range)' },
      },
      handler: (opts) => core.manageVolumeProfile({ action: 'add', type: opts.type }),
    }],
    ['remove', {
      description: 'Remove a volume profile study by entity ID. Usage: tv vp remove <entity_id>',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Entity ID required. Usage: tv vp remove ZqQ6dh (find it via tv vp read)');
        return core.manageVolumeProfile({ action: 'remove', entity_id: positionals[0] });
      },
    }],
  ]),
});
