/** The built-in `json` reporter: the report document to stdout, and nothing else there. */

import { builtin } from './builtin-id.ts';
import type { Reporter } from '../run-types.ts';

/**
 * Prints the run's report-1 document to stdout once the run is over. It is
 * not interactive, so beside it alone the runner prints on stderr. The
 * document prints from `onSummary`, which a forced stop never skips.
 */
export function json(): Reporter {
  return builtin('json', {
    name: 'json',
    onSummary(_rows, run) {
      process.stdout.write(`${JSON.stringify(run.report, null, 2)}\n`);
    },
  }, true);
}
