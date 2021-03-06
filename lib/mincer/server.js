/**
 *  class Server
 *
 *  Easy to use server/middleware ideal for serving assets your assets:
 *
 *  - great for development, as it recompiles canged assets on-fly
 *  - great for production, as it caches results, and it can become as effecient
 *    as `staticCache` middleware (or even better) of `connect` module.
 *
 *
 *  ##### Examples
 *
 *      // development mode
 *      var srv = new Server(env);
 *
 *      // production mode
 *      var srv = new Server(env.index);
 *
 *      // production mode (restrictive)
 *      var files = ['app.js', 'app.css', 'logo.jpg'];
 *      var srv = new Server(env.index, manifest.compile(files));
 *
 *  You can use this server in your connect app (or as `request` listener of
 *  `http` server) like this:
 *
 *      app.use(function (req, res) {
 *        srv.handle(req, res);
 *      });
 *
 *      // there's a shorthand syntax as well:
 *
 *      app.use(mincer.createServer(env));
 **/

'use strict';


// stdlib
var zlib   = require('zlib');
var http   = require('http');
var url    = require('url');
var format = require('util').format;


// 3rd-party
var mimoza       = require('mimoza');
var compressible = require('compressible');


// internal
var logger      = require('./logger');
var prop        = require('./common').prop;
var start_timer = require('./common').timer;


////////////////////////////////////////////////////////////////////////////////


/**
 *  new Server(environment[, manifest])
 *  - environment (Environment|Index)
 *  - manifest (Object): Data returned by [[Manifest#compile]]
 *
 *  If you provide `manifest`, then server will not even try to find files on
 *  FS unless they are specified in the `manifest`.
 **/
var Server = module.exports = function Server(environment, manifest) {
  prop(this, 'environment', environment);
  prop(this, 'manifest',    manifest);
};


// Retruns fingerprint from the pathname
var FINGERPRINT_RE = /-([0-9a-f]{32,40})\.[^.]+(?:\.map)?$/i;
function get_fingerprint(pathname) {
  var m = FINGERPRINT_RE.exec(pathname);
  return m ? m[1] : null;
}


// Helper to write the code and end response
function end(res, code) {
  res.writeHead(code);

  if (code >= 400) {
    // write human-friendly error message
    res.end('[' + code + '] ' + http.STATUS_CODES[code]);
    return;
  }

  // just end with no body for 304 responses and such
  res.end();
}


// Returns Etag value for `asset`
function etag(asset) {
  return '"' + asset.digest + '"';
}


// Returns true whenever If-None-Match header matches etag of `asset`
function is_etag_match(req, asset) {
  return etag(asset) === req.headers['if-none-match'];
}


// Tells whenever browser accepts gzip at all
function is_gzip_accepted(req) {
  var accept = req.headers['accept-encoding'] || '';
  return accept === '*' || accept.indexOf('gzip') >= 0;
}


// Returns log event structure.
//
function log_event(req, code, message, elapsed) {
  return {
    code:           code,
    message:        message,
    elapsed:        elapsed,
    request:        req,
    url:            req.originalUrl || req.url,
    method:         req.method,
    headers:        req.headers,
    httpVersion:    req.httpVersion,
    remoteAddress:  req.connection.remoteAddress
  };
}


function serve_asset(self, asset, req, res, timer) {
  var buffer, length;

  // OK
  self.log('info', log_event(req, 200, 'OK', timer.stop()));

  buffer = asset.__server_buffer__;
  length = asset.__server_buffer__.length;

  //
  // Alter some headers for gzipped assets
  //

  //
  // Only gzip is supported:
  //
  // - too many issues with deflate
  // - browsers that support deflate well, also support gzip
  //
  // Details:
  //
  // - http://www.vervestudios.co/projects/compression-tests/results
  // - http://zoompf.com/blog/2012/02/lose-the-wait-http-compression
  //

  if (asset.__server_buffer_gzipped__ && is_gzip_accepted(req)) {
    buffer = asset.__server_buffer_gzipped__;
    length = asset.__server_buffer_gzipped__.length;
    res.setHeader('Content-Encoding', 'gzip');
  }

  //
  // Set content type and length headers
  // Force charset for text assets, to avoid problems with JS loaders
  //
  res.setHeader('Content-Type', asset.contentType + (mimoza.isText(asset.contentType) ? '; charset=UTF-8' : ''));
  res.setHeader('Content-Length', length);

  res.statusCode = 200;

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  res.end(buffer);
}


function serve_source_map(self, asset, req, res, timer) {
  var length, buffer;

  if (!asset.__server_sourcemap_buffer__) {
    self.log('info', log_event(req, 404, 'Not Found', timer.stop()));

    res.statusCode = 404;
  } else {
    self.log('info', log_event(req, 200, 'OK', timer.stop()));

    res.statusCode = 200;

    buffer = asset.__server_sourcemap_buffer__;
    length = asset.__server_sourcemap_buffer__.length;

    if (asset.__gzipped_server_sourcemap__ && is_gzip_accepted(req)) {
      buffer = asset.__gzipped_server_sourcemap__;
      length = asset.__gzipped_server_sourcemap__.length;
      res.setHeader('Content-Encoding', 'gzip');
    }

    res.setHeader('Content-Type',  'application/json; charset=UTF-8');
    res.setHeader('Content-Length', length);
  }

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  res.end(buffer);
}


/** internal
 *  Server#log(level, event) -> Void
 *  - level (String): Event level
 *  - event (Object): Event data
 *
 *  This is an internal method that formats and writes messages using
 *  [[Mincer.logger]] and it fits almost 99% of cases. But if you want to
 *  integrate this [[Server]] into your existing application and have logs
 *  formatted in your way you can override this method.
 *
 *
 *  ##### Event
 *
 *  Event is an object with following fields:
 *
 *  - **code** (Number): Status code
 *  - **message** (String): Message
 *  - **elapsed** (Number): Time elapsed in milliseconds
 *  - **url** (String): Request url. See `http.request.url`.
 *  - **method** (String): Request method. See `http.request.method`.
 *  - **headers** (Object): Request headers. See `http.request.headers`.
 *  - **httpVersion** (String): Request httpVersion. See `http.request.httpVersion`.
 **/
Server.prototype.log = function log(level, event) {
  logger[level](format('Served asset %s - %d %s (%dms)',
                       event.url, event.code, event.message, event.elapsed));
};


/**
 *  Server#compile(pathname, bundle, callback(err, asset)) -> Void
 *  - pathname (String)
 *  - bundle (Boolean)
 *  - callback (Function)
 *
 *  Finds and compiles given asset.
 **/
Server.prototype.compile = function compile(pathname, bundle, callback) {
  var asset;

  try {
    asset = (this.manifest && !this.manifest.assets[pathname]) ? null
          : this.environment.findAsset(pathname, { bundle: !!bundle });
  } catch (err) {
    callback(err);
    return;
  }

  if (!asset) {
    callback(/* err = undefined, asset = undefined */);
    return;
  }

  // return immediately if asset was previously processed
  if (asset.__server_buffer__) {
    callback(null, asset);
    return;
  }

  // For bundled assets create patched content with embedded url.
  if (asset.sourceMap && asset.mappingUrlComment) {
    prop(asset, '__server_buffer__', new Buffer(asset.source + asset.mappingUrlComment()));
  } else {
    prop(asset, '__server_buffer__', asset.buffer);
  }

  if (asset.sourceMap) {
    prop(asset, '__server_sourcemap_buffer__', new Buffer(')]}\'\n' + asset.sourceMap));
    // Strange ")]}'\n" line added to sourcemap is for XSSI protection.
    // See spec for details.
  }

  if (!compressible(asset.contentType)) {
    callback(null, asset);
    return;
  }

  // Gzip and cache buffer
  zlib.gzip(asset.__server_buffer__, function (err, buffer) {
    if (err) {
      callback(err);
      return;
    }

    // set __server_buffer_gzipped__ buffer only if we have compression profit
    if (buffer.length < asset.__server_buffer__.length) {
      prop(asset, '__server_buffer_gzipped__', buffer);
    }

    if (!asset.__server_sourcemap_buffer__) {
      callback(null, asset);
      return;
    }

    zlib.gzip(asset.__server_sourcemap_buffer__, function (err, buffer) {
      if (err) {
        callback(err);
        return;
      }

      // set __server_buffer_gzipped__ buffer only if we have compression profit
      if (buffer.length < asset.__server_sourcemap_buffer__.length) {
        prop(asset, '__gzipped_server_sourcemap__', buffer);
      }

      callback(null, asset);
    });
  });
};


/**
 *  Server#handle(req, res) -> Void
 *  - req (http.ServerRequest)
 *  - res (hhtp.ServerResponse)
 *
 *  Hander function suitable for usage as server `request` event listener or as
 *  middleware for TJ's `connect` module.
 *
 *
 *  ##### Exampple
 *
 *  var assetsSet
 **/
Server.prototype.handle = function handle(req, res) {
  var self        = this,
      timer       = start_timer(),
      pathname    = url.parse(req.url).pathname,
      bundle      = !/body=[1t]/.test(url.parse(req.url).query),
      sourceMap   = /\.map$/i.test(pathname),
      fingerprint = get_fingerprint(pathname);

  try {
    pathname = decodeURIComponent(pathname.replace(/^\//, ''));
  } catch (err) {
    self.log('error', log_event(req, 400, 'Failed decode URL', timer.stop()));
    end(res, 400);
    return;
  }

  // forbid requests with `..` or NUL chars
  if (pathname.indexOf('..') >= 0 || pathname.indexOf('\u0000') >= 0) {
    self.log('error', log_event(req, 403, 'URL contains unsafe chars', timer.stop()));
    end(res, 403);
    return;
  }

  // ignore non-GET requests
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    self.log('error', log_event(req, 403, 'HTTP method not allowed', timer.stop()));
    end(res, 403);
    return;
  }

  // remove fingerprint (digest) from URL
  if (fingerprint) {
    pathname = pathname.replace('-' + fingerprint, '');
  }

  // remove .map extension from pathname
  if (sourceMap) {
    pathname = pathname.replace(/\.map$/i, '');
  }

  // try to find and compile asset
  this.compile(pathname, bundle, function (err, asset) {
    if (err) {
      err = err.message || err.toString();
      self.log('error', log_event(req, 500, 'Error compiling asset: ' + err, timer.stop()));
      end(res, 500);
      return;
    }

    // asset not found
    if (!asset) {
      self.log('error', log_event(req, 404, 'Not found', timer.stop()));
      end(res, 404);
      return;
    }

    //
    // Asset found. Sending headers for 200/304 responses:
    // http://tools.ietf.org/html/draft-ietf-httpbis-p4-conditional-18#section-4.1
    //

    //
    // Ranges are not supported yet
    //

    res.removeHeader('Accept-Ranges');

    //
    // Mark for proxies, that we can return different content (plain & gzipped),
    // depending on specified (comma-separated) headers
    //

    res.setHeader('Vary', 'Accept-Encoding');

    //
    // Set caching headers
    //

    if (fingerprint) {
      // If the request url contains a fingerprint, set a long
      // expires on the response
      res.setHeader('Cache-Control', 'public, max-age=31536000');
    } else {
      // Otherwise set `must-revalidate` since the asset could be modified.
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }

    res.setHeader('Date',           (new Date()).toUTCString());
    res.setHeader('Last-Modified',  asset.mtime.toUTCString());
    res.setHeader('ETag',           etag(asset));
    res.setHeader('Server',         'Nokla 1630');

    //
    // Check if asset's etag matches `if-none-match` header
    //

    if (is_etag_match(req, asset)) {
      self.log('info', log_event(req, 304, 'Not Modified', timer.stop()));
      end(res, 304);
      return;
    }

    if (sourceMap) {
      serve_source_map(self, asset, req, res, timer);
    } else {
      serve_asset(self, asset, req, res, timer);
    }
  });
};


/**
 *  Server.createServer(environment[, manifest]) -> Function
 *  - environment (Environment)
 *  - manifest (Object)
 *
 *  Returns a server function suitable to be used as `request` event handler of
 *  `http` Node library module or as `connect` middleware.
 *
 *
 *  ##### Example
 *
 *      // Using TJ's Connect module
 *      var app = connect();
 *      app.use('/assets/', Server.createServer(env));
 *
 *
 *  ##### See Also
 *
 *  - [[Server.new]]
 **/
Server.createServer = function (environment, manifest) {
  var srv = new Server(environment, manifest);
  return function (req, res) {
    return srv.handle(req, res);
  };
};
