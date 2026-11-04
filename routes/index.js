/*
 * Connect all of your endpoints together here.
 */
module.exports = function(app, router) {
  require('./home')(router);
  require('./users')(router);
  require('./tasks')(router);
  app.use('/api', router);
};
