// Local aggregate report; never contacts customers or uploads participant data.
import { readFileSync } from 'node:fs';
import { pilotMetrics } from '../src/pilot.mjs';

const [file, ...args] = process.argv.slice(2);
if (!file || (args.length && (args[0] !== '--as-of' || args.length !== 2))) {
  console.error('Usage: node scripts/pilot-metrics.mjs participants.json [--as-of UTC-timestamp]');
  process.exit(1);
}
try {
  console.log(JSON.stringify(pilotMetrics(JSON.parse(readFileSync(file, 'utf8')), args.length ? Date.parse(args[1]) : Date.now()), null, 2));
} catch (e) {
  console.error(`Pilot metrics unavailable: ${e instanceof SyntaxError ? 'invalid participant JSON' : e.message}`);
  process.exit(1);
}
