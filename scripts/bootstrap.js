'use strict';

const { createRuntimeService } = require('../src/install/runtimeService');

function main() {
  try {
    const status = createRuntimeService({ platform: process.platform }).bootstrap();
    console.log('Job Hunter preparado: ' + JSON.stringify(status));
  } catch (error) {
    console.error(`[bootstrap] ${error.code || 'ERROR'}: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { main };
