function getRowValue(row, camelName, lowerName) {
  return row?.[camelName] ?? row?.[lowerName];
}

module.exports = {
  getRowValue
};
