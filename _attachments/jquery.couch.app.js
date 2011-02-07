// Licensed under the Apache License, Version 2.0 (the "License"); you may not
// use this file except in compliance with the License.  You may obtain a copy
// of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
// WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.  See the
// License for the specific language governing permissions and limitations under
// the License.

// Usage: The passed in function is called when the page is ready.
// CouchApp passes in the app object, which takes care of linking to 
// the proper database, and provides access to the CouchApp helpers.
// $.couch.app(function(app) {
//    app.db.view(...)
//    ...
// });

(function($) {

  function Design(db, name, code) {
    this.doc_id = "_design/"+name;
    if (code) {
      this.code_path = this.doc_id + "/" + code;
    } else {
      this.code_path = this.doc_id;
    }
    this.view = function(view, opts) {
      db.view(name+'/'+view, opts);
    };
    this.list = function(list, view, opts) {
      db.list(name+'/'+list, view, opts);
    };
  }

  function docForm() { alert("docForm has been moved to vendor/couchapp/lib/docForm.js, use app.require to load") };

  function resolveModule(path, names, parents, current) {
    parents = parents || [];
    if (names.length === 0) {
      if (typeof current != "string") {
        throw ["error","invalid_require_path",
          'Must require a JavaScript string, not: '+(typeof current)];
      }
      return [current, parents];
    }
    var n = names.shift();
    if (n == '..') {
      parents.pop();
      var pp = parents.pop();
      if (!pp) {
        throw ["error", "invalid_require_path", path];
      }
      return resolveModule(path, names, parents, pp);
    } else if (n == '.') {
      var p = parents.pop();
      if (!p) {
        throw ["error", "invalid_require_path", path];
      }
      return resolveModule(path, names, parents, p);
    } else {
      parents = [];
    }
    if (!current[n]) {
      throw ["error", "invalid_require_path", path];
    }
    parents.push(current);
    return resolveModule(path, names, parents, current[n]);
  }

  function makeRequire(ddoc) {
    var moduleCache = [];
    function getCachedModule(name, parents) {
      var key, i, len = moduleCache.length;
      for (i=0;i<len;++i) {
        key = moduleCache[i].key;
        if (key[0] === name && key[1] === parents) {
          return moduleCache[i].module;
        }
      }
      return null;
    }
    function setCachedModule(name, parents, module) {
      moduleCache.push({ key: [name, parents], module: module });
    }
    var require = function (name, parents) {
      var cachedModule = getCachedModule(name, parents);
      if (cachedModule !== null) {
        return cachedModule;
      }
      var exports = {};
      var resolved = resolveModule(name, name.split('/'), parents, ddoc);
      var source = resolved[0]; 
      parents = resolved[1];
      var s = "var func = function (exports, require) { " + source + " };";
      try {
        eval(s);
        func.apply(ddoc, [exports, function(name) {return require(name, parents)}]);
      } catch(e) { 
        throw ["error","compilation_error","Module require('"+name+"') raised error "+e.toSource()]; 
      }
      setCachedModule(name, parents, exports);
      return exports;
    }
    return require;
  };

  function mockReq() {
    var p = document.location.pathname.split('/'),
      qs = document.location.search.replace(/^\?/,'').split('&'),
      q = {};
    qs.forEach(function(param) {
      var ps = param.split('='),
        k = decodeURIComponent(ps[0]),
        v = decodeURIComponent(ps[1]);
      if (["startkey", "endkey", "key"].indexOf(k) != -1) {
        q[k] = JSON.parse(v);
      } else {
        q[k] = v;
      }
    });
    p.shift();
    return {
      path : p,
      query : q
    };
  };

  $.couch.app = $.couch.app || function(appFun, opts) {
    opts = opts || {};
    var urlPrefix = (opts.urlPrefix || ""),
      index = urlPrefix.split('/').length,
      fragments = unescape(document.location.href).split('/'),
      dbname = opts.db || fragments[index + 2],
      dname = opts.design || fragments[index + 4];
    $.couch.urlPrefix = urlPrefix;
    var db = $.couch.db(dbname),
      design = new Design(db, dname, opts.load_path);
    var appExports = $.extend({
      db : db,
      design : design,
      view : design.view,
      list : design.list,
      docForm : docForm, // deprecated
      req : mockReq()
    }, $.couch.app.app);
    function handleDDoc(ddoc) {        
      if (ddoc) {
        appExports.ddoc = ddoc;
        appExports.require = makeRequire(ddoc);
      }
      appFun.apply(appExports, [appExports]);
    }
    if (opts.ddoc) {
      // allow the ddoc to be embedded in the html
      // to avoid a second http request
      $.couch.app.ddocs[design.doc_id] = opts.ddoc;
    }
    if ($.couch.app.ddocs[design.doc_id]) {
      $(function() {handleDDoc($.couch.app.ddocs[design.doc_id])});
    } else {
      // only open 1 connection for this ddoc 
      if ($.couch.app.ddoc_handlers[design.doc_id]) {
        // we are already fetching, just wait
        $.couch.app.ddoc_handlers[design.doc_id].push(handleDDoc);
      } else {
        $.couch.app.ddoc_handlers[design.doc_id] = [handleDDoc];
        
        function onSuccess(doc) {
          $.couch.app.ddocs[design.doc_id] = doc;
          $.couch.app.ddoc_handlers[design.doc_id].forEach(function(h) {
            $(function() {h(doc)});
          });
          $.couch.app.ddoc_handlers[design.doc_id] = null;
        };
        
        // use getDbProperty to bypass %2F encoding on _show/app        
        db.getDbProperty(design.code_path, {
          success : opts.compile === true ? function(doc) {
            // If opts.compile = true, then compile functions into <script> tags
            $.couch.compile(doc, onSuccess);
          } : onSuccess,
          error : function() {
            $.couch.app.ddoc_handlers[design.doc_id].forEach(function(h) {
              $(function() {h()});
            });
            $.couch.app.ddoc_handlers[design.doc_id] = null;
          }
        });
      }
    }
  };
  $.couch.app.ddocs = {};
  $.couch.app.ddoc_handlers = {};
  
  // Compile doc and place all evently widgets as scripts on a page
  // to simplify debugging & breakpoints
  $.couch.compile = function(doc, callback) {
    if (!doc || !doc.couchapp || !doc.couchapp.manifest) return callback(doc);
    
    var scripts = doc.couchapp.manifest.filter(function(path) {
          return /^evently\/.*\.js$/.test(path);
        }),
        groups = {};
    
    
    // Group all functions in evently widget
    // and place it into groups[widget-name] array   
    scripts.forEach(function(path) {
      var fragments = path.split('/'),
          filename = fragments.pop().replace(/\.js$/, '');
          
      // Find a place for function
      var place = fragments.reduce(function(prev, fragment) {
        return prev[fragment] = prev[fragment] || {};
      }, doc);
      
      var content = place[filename],
          id = 'cb' + Math.round(Math.random() * 1e9),
          contents = groups[fragments[1]] = groups[fragments[1]] || [];     
      
      // Add pretty comment, that will identify function
      contents.push('\r\n\r\n/** ' + doc._id + '/' + path + '**/\r\n\r\n');
      
      // Wrap code in try {...} catch(e) { ...}
      contents.push(['try{', id, '((function(){return ',
                 content.replace(/(\r\n|\r|\n)/g, '\r\n'),
                 '})());} catch(e) { $.log(e); }'].join(''));
      
      // When this callback will be called - string value in a widget
      // will be replaced w/ compiled function in <script> tag
      window[id] = function(fn) {
        delete window[id];
        place[filename] = fn;
      };      
                 
    });
    
    // For each group - create <script src="data:...."></script>
    // with code of widget's functions
    for (var groupKey in groups) {
      if (!groups.hasOwnProperty(groupKey)) return;
      
      var contents = groups[groupKey],      
          script = document.createElement('script');
        
          script.src = ['data:text/javascript;',
                        doc._id, '/evently/', groupKey,
                        ';plain,',
                        escape(contents.join('\r\n'))].join('');

          document.body.appendChild(script);
    };
      
    // Create final script, that will call callback
    // TODO: Find a better way for that
    var finalCallback = 'final' + Math.round(Math.random() * 1e9)
    
    window[finalCallback] = function() {
      delete window[finalCallback];
      callback(doc);
    };     
     
    var script = document.createElement('script'),
        code = document.createTextNode(finalCallback + '()');
    
    script.appendChild(code);
    document.body.appendChild(script);
  };
  
  // legacy support. $.CouchApp is deprecated, please use $.couch.app
  $.CouchApp = $.couch.app;
})(jQuery);

// JavaScript 1.6 compatibility functions that are missing from IE7/IE8

if (!Array.prototype.forEach)
{
    Array.prototype.forEach = function(fun /*, thisp*/)
    {
        var len = this.length >>> 0;
        if (typeof fun != "function")
            throw new TypeError();

        var thisp = arguments[1];
        for (var i = 0; i < len; i++)
        {
            if (i in this)
                fun.call(thisp, this[i], i, this);
        }
    };
}

if (!Array.prototype.indexOf)
{
    Array.prototype.indexOf = function(elt)
    {
        var len = this.length >>> 0;

        var from = Number(arguments[1]) || 0;
        from = (from < 0)
                ? Math.ceil(from)
                : Math.floor(from);
        if (from < 0)
            from += len;

        for (; from < len; from++)
        {
            if (from in this &&
                this[from] === elt)
                return from;
        }
        return -1;
    };
}
