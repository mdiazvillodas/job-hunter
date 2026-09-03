'use strict';

class ConfigurationRequiredError extends Error {
  constructor(detail) {
    super(`Job Hunter todavia no esta configurado${detail ? `. ${detail}` : '.'}`);
    this.name = 'ConfigurationRequiredError';
    this.code = 'CONFIGURATION_REQUIRED';
  }
}

module.exports = { ConfigurationRequiredError };
