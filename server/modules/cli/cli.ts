#!/usr/bin/env node

import { createCliApplication } from './index.js';
import logger from '@/shared/logger.js';
const log = logger.child({ module: 'cli-entry' });

const cliApplication = createCliApplication();

cliApplication.run(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  log.error('\n❌ Error:', message);
  process.exitCode = 1;
});
