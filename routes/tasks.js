const User = require('../models/user');
const Task = require('../models/task');
const {bad, missing, validId, projection, list, validateTask, wrap, transaction} = require('./helpers');

async function assignedUser(input, session) {
  if (!input.assignedUser) {
    if (input.suppliedName !== undefined && input.suppliedName !== 'unassigned')
      throw bad('Unassigned tasks must have assignedUserName "unassigned"');
    return null;
  }
  const user = await User.findById(input.assignedUser).session(session);
  if (!user) throw missing('Assigned user not found');
  if (input.suppliedName !== undefined && input.suppliedName !== user.name)
    throw bad('assignedUserName does not match the assigned user');
  return user;
}
async function syncTask(taskId, previousUser, user, completed, session) {
  // Pull globally to keep the reverse reference accurate even after reassignment.
  await User.updateMany({pendingTasks: taskId}, {$pull: {pendingTasks: taskId}}, {session});
  if (user && !completed)
    await User.updateOne({_id: user._id}, {$addToSet: {pendingTasks: taskId}}, {session});
}
module.exports = function(router) {
  router.route('/tasks')
    .get(wrap((req, res) => list(req, res, Task, 100)))
    .post(wrap(async (req, res) => {
      const input = validateTask(req.body);
      const task = await transaction(async session => {
        const user = await assignedUser(input, session);
        const [created] = await Task.create([{
          name: input.name, description: input.description, deadline: input.deadline,
          completed: input.completed, assignedUser: user ? String(user._id) : '',
          assignedUserName: user ? user.name : 'unassigned'
        }], {session});
        await syncTask(String(created._id), '', user, input.completed, session);
        return created;
      });
      res.status(201).json({message: 'Task created', data: task});
    }));
  router.route('/tasks/:id')
    .get(wrap(async (req, res) => {
      if (!validId(req.params.id)) throw missing('Task not found');
      const select = projection(req);
      let query = Task.findById(req.params.id);
      if (select) query = query.select(select);
      const task = await query.lean();
      if (!task) throw missing('Task not found');
      res.json({message: 'OK', data: task});
    }))
    .put(wrap(async (req, res) => {
      const task = await transaction(async session => {
        if (!validId(req.params.id)) throw missing('Task not found');
        const existing = await Task.findById(req.params.id).session(session);
        if (!existing) throw missing('Task not found');
        const input = validateTask(req.body);
        const user = await assignedUser(input, session);
        const previousUser = existing.assignedUser;
        Object.assign(existing, {name: input.name, description: input.description, deadline: input.deadline,
          completed: input.completed, assignedUser: user ? String(user._id) : '',
          assignedUserName: user ? user.name : 'unassigned'});
        await existing.save({session});
        await syncTask(String(existing._id), previousUser, user, input.completed, session);
        return existing;
      });
      res.json({message: 'Task updated', data: task});
    }))
    .delete(wrap(async (req, res) => {
      await transaction(async session => {
        if (!validId(req.params.id)) throw missing('Task not found');
        const task = await Task.findById(req.params.id).session(session);
        if (!task) throw missing('Task not found');
        await User.updateMany({pendingTasks: String(task._id)},
          {$pull: {pendingTasks: String(task._id)}}, {session});
        await Task.deleteOne({_id: task._id}, {session});
      });
      res.status(204).end();
    }));
  return router;
};
