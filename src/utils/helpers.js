function getRowValue(row, camelName) {
  const lowerName = camelName.toLowerCase();
  return row?.[camelName] ?? row?.[lowerName];
}

module.exports = {
  getRowValue
};
