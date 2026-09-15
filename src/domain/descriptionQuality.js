'use strict';

function isDescriptionUsable(description) {
  return typeof description === 'string' && description.trim().length >= 300;
}

const DESCRIPTION_INSUFFICIENT = 'description_missing_or_insufficient';

module.exports = { isDescriptionUsable, DESCRIPTION_INSUFFICIENT };
