// Optional fixture-only diagnostics: no parameter values, credentials or bodies.
const Database = require(process.env.QA_SQLITE_MODULE);
const original = Database.prototype.prepare;
const transaction = Database.prototype.transaction;
Database.prototype.transaction = function (fn) {
  const wrapped = transaction.call(this, fn);
  const trace = (action) => (...args) => {
    try { return action(...args); }
    catch (error) { console.error('[fixture transaction]', error.code, error.message, error.stack); throw error; }
  };
  const result = trace(wrapped);
  for (const mode of ['deferred', 'immediate', 'exclusive']) result[mode] = trace(wrapped[mode]);
  return result;
};
Database.prototype.prepare = function (sql) {
  const statement = original.call(this, sql);
  for (const method of ['get', 'all', 'run']) {
    const action = statement[method].bind(statement);
    statement[method] = (...args) => {
      try { return action(...args); }
      catch (error) { console.error('[fixture SQL]', error.code, error.message, String(sql).slice(0, 160)); throw error; }
    };
  }
  return statement;
};
