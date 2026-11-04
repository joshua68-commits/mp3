module.exports = function (router) {

  router.get('/', (req, res) => res.json({message: 'Llama.io API is running', data: {}}));
  
  return router;
}
