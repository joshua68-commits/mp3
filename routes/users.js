const User = require('../models/user');
const Task = require('../models/task');
const {bad, missing, validId, projection, list, validateUser, wrap, transaction} = require('./helpers');

async function checkPending(ids, session) {
  const tasks = await Task.find({_id: {$in: ids}}).session(session);
  if (tasks.length !== ids.length) throw missing('One or more referenced tasks do not exist');
  if (tasks.some(t => t.completed)) throw bad('Completed tasks cannot be in pendingTasks');
  return tasks;
}
async function synchronizeUser(user, oldIds, newIds, session) {
  const id = String(user._id);
  const oldSet = new Set(oldIds);
  const newSet = new Set(newIds);
  const removed = [...oldSet].filter(x => !newSet.has(x));
  // Replacements remove old pending assignments, but preserve assigned completed tasks.
  if (removed.length) await Task.updateMany({_id: {$in: removed}, assignedUser: id},
    {$set: {assignedUser: '', assignedUserName: 'unassigned'}}, {session});
  if (newIds.length) {
    // A task can belong to only one user's pending list.
    await User.updateMany({_id: {$ne: user._id}}, {$pull: {pendingTasks: {$in: newIds}}}, {session});
    await Task.updateMany({_id: {$in: newIds}},
      {$set: {assignedUser: id, assignedUserName: user.name}}, {session});
  }
  // Also rename assignments for completed tasks that aren't in pendingTasks.
  await Task.updateMany({assignedUser: id}, {$set: {assignedUserName: user.name}}, {session});
}
module.exports = function(router) {
  router.route('/users')
    .get(wrap((req, res) => list(req, res, User, undefined)))
    .post(wrap(async (req, res) => {
      const input = validateUser(req.body);
      const user = await transaction(async session => {
        await checkPending(input.pendingTasks, session);
        const [created] = await User.create([input], {session});
        await synchronizeUser(created, [], input.pendingTasks, session);
        return created;
      });
      res.status(201).json({message: 'User created', data: user});
    }));
  router.route('/users/:id')
    .get(wrap(async (req, res) => {
      if (!validId(req.params.id)) throw missing('User not found');
      const select = projection(req);
      let query = User.findById(req.params.id);
      if (select) query = query.select(select);
      const user = await query.lean();
      if (!user) throw missing('User not found');
      res.json({message: 'OK', data: user});
    }))
    .put(wrap(async (req, res) => {
      const user = await transaction(async session => {
        if (!validId(req.params.id)) throw missing('User not found');
        const existing = await User.findById(req.params.id).session(session);
        if (!existing) throw missing('User not found');
        const input = validateUser(req.body);
        await checkPending(input.pendingTasks, session);
        const oldIds = existing.pendingTasks.slice();
        existing.name = input.name;
        existing.email = input.email;
        existing.pendingTasks = input.pendingTasks;
        await existing.save({session});
        await synchronizeUser(existing, oldIds, input.pendingTasks, session);
        return existing;
      });
      res.json({message: 'User updated', data: user});
    }))
    .delete(wrap(async (req, res) => {
      await transaction(async session => {
        if (!validId(req.params.id)) throw missing('User not found');
        const user = await User.findById(req.params.id).session(session);
        if (!user) throw missing('User not found');
        await Task.updateMany({assignedUser: String(user._id)},
          {$set: {assignedUser: '', assignedUserName: 'unassigned'}}, {session});
        await User.deleteOne({_id: user._id}, {session});
      });
      res.status(204).end();
    }));
  return router;
};
