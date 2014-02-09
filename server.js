var express = require('express'),
    app = express(),
    port = process.env['PORT'] || 8080;

app.use(express.compress());
app.use(express.static('public'));

app.listen(port, function() {
    console.log('Listening on port', port);
});
