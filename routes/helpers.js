const mongoose = require('mongoose');

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (message) => new ApiError(400, message);
const missing = (message) => new ApiError(404, message);
const validId = (id) => typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id);
const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (v, key) => Object.prototype.hasOwnProperty.call(v, key);

function parseJSON(v, label, fallback) {
  if (v === undefined) return fallback;
  if (typeof v !== 'string') throw bad(`Invalid ${label} parameter`);
  try { return JSON.parse(v); }
  catch { throw bad(`Invalid JSON in ${label} parameter`); }
}
function projection(req) {
  const value = parseJSON(req.query.select, 'select', undefined);
  if (value === undefined) return undefined;
  if (!obj(value) || Object.values(value).some(v => v !== 0 && v !== 1))
    throw bad('select must be an object of 0 and 1 values');
  const vals = Object.entries(value).filter(([k]) => k !== '_id').map(([, v]) => v);
  if (vals.includes(0) && vals.includes(1)) throw bad('Cannot mix included and excluded fields');
  return value;
}
function collectionOptions(req, defaultLimit) {
  const where = parseJSON(req.query.where, 'where', {});
  const sort = parseJSON(req.query.sort, 'sort', {});
  const select = projection(req);
  const skip = parseJSON(req.query.skip, 'skip', 0);
  const limit = parseJSON(req.query.limit, 'limit', defaultLimit);
  const count = parseJSON(req.query.count, 'count', false);
  if (!obj(where)) throw bad('where must be an object');
  if (!obj(sort) || Object.values(sort).some(v => v !== 1 && v !== -1))
    throw bad('sort must be an object of 1 and -1 values');
  if (!Number.isSafeInteger(skip) || skip < 0) throw bad('skip must be a nonnegative integer');
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
    throw bad('limit must be a nonnegative integer');
  if (typeof count !== 'boolean') throw bad('count must be true or false');
  return {where, sort, select, skip, limit, count};
}
async function list(req, res, Model, defaultLimit) {
  const o = collectionOptions(req, defaultLimit);
  if (o.count) return res.status(200).json({message: 'OK', data: await Model.countDocuments(o.where)});
  let query = Model.find(o.where).sort(o.sort).skip(o.skip);
  if (o.select !== undefined) query = query.select(o.select);
  if (o.limit !== undefined) query = query.limit(o.limit);
  res.status(200).json({message: 'OK', data: await query.lean()});
}
function validateUser(body) {
  if (!obj(body)) throw bad('Expected a JSON user object');
  if (typeof body.name !== 'string' || !body.name.trim()) throw bad('User name is required');
  if (typeof body.email !== 'string' || !body.email.trim()) throw bad('User email is required');
  const pending = own(body, 'pendingTasks') ? body.pendingTasks : [];
  if (!Array.isArray(pending) || pending.some(id => !validId(id)))
    throw bad('pendingTasks must contain valid task IDs');
  return {name: body.name.trim(), email: body.email.trim(), pendingTasks: [...new Set(pending.map(id => id.toLowerCase()))]};
}
function validateTask(body) {
  if (!obj(body)) throw bad('Expected a JSON task object');
  if (typeof body.name !== 'string' || !body.name.trim()) throw bad('Task name is required');
  if (typeof body.deadline !== 'string' || !body.deadline.trim() || !Number.isFinite(Date.parse(body.deadline)))
    throw bad('A valid task deadline is required');
  if (own(body, 'description') && typeof body.description !== 'string') throw bad('description must be a string');
  if (own(body, 'completed') && typeof body.completed !== 'boolean') throw bad('completed must be a boolean');
  if (own(body, 'assignedUser') && (typeof body.assignedUser !== 'string' || (body.assignedUser !== '' && !validId(body.assignedUser))))
    throw bad('assignedUser must be empty or a valid user ID');
  if (own(body, 'assignedUserName') && typeof body.assignedUserName !== 'string')
    throw bad('assignedUserName must be a string');
  const assignedUser = body.assignedUser || '';
  return {name: body.name.trim(), description: body.description ?? '', deadline: new Date(body.deadline),
    completed: body.completed ?? false, assignedUser, suppliedName: own(body, 'assignedUserName') ? body.assignedUserName : undefined};
}
function respondError(err, res) {
  if (res.headersSent) return;
  if (err instanceof ApiError) return res.status(err.status).json({message: err.message, data: null});
  if (err.code === 11000) return res.status(400).json({message: 'That email is already in use', data: null});
  if (err instanceof mongoose.Error.ValidationError || err instanceof mongoose.Error.CastError || err.name === 'StrictModeError')
    return res.status(400).json({message: 'Invalid request data', data: null});
  console.error(err);
  return res.status(500).json({message: 'An unexpected server error occurred', data: null});
}
const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(e => respondError(e, res));
const transaction = async (fn) => {
  const session = await mongoose.startSession();
  try { let result; await session.withTransaction(async () => { result = await fn(session); }); return result; }
  finally { await session.endSession(); }
};
module.exports = {bad, missing, validId, projection, list, validateUser, validateTask, wrap, transaction};
