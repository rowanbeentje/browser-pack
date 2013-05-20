var JSONStream = require('JSONStream');
var duplexer = require('duplexer');
var through = require('through');
var uglify = require('uglify-js');

var fs = require('fs');
var path = require('path');
var detective = require('detective');

var combineSourceMap = require('combine-source-map');

var prelude = (function () {
    var src = fs.readFileSync(path.join(__dirname, 'prelude.js'), 'utf8');
    return uglify(src) + '({';
})();

var byIndexPrelude = (function () {
    var src = fs.readFileSync(path.join(__dirname, 'byIndexPrelude.js'), 'utf8');
    return uglify(src) + '({';
})();

function newlinesIn(src) {
  if (!src) return 0;
  var newlines = src.match(/\n/g);

  return newlines ? newlines.length : 0;
}

module.exports = function (opts) {
    if (!opts) opts = {};
    var selectedPrelude = opts.requireByIndex ? byIndexPrelude : prelude;
    var parser = opts.raw ? through() : JSONStream.parse([ true ]);
    var output = through(write, end);
    parser.pipe(output);
    
    var first = true;
    var entries = [];
    var order = []; 
    
    var lineno = 1 + newlinesIn(selectedPrelude);
    var sourcemap;

    return duplexer(parser, output);
    
    function write (row) {
        var source = row.source;
        if (first) this.queue(selectedPrelude);
        
        if (row.sourceFile) { 
            sourcemap = sourcemap || combineSourceMap.create();
            sourcemap.addFile(
                { sourceFile: row.sourceFile, source: source },
                { line: lineno }
            );
        }

        // If direct lookups mode is enabled, iterate over the string matches - backwards, so
        // that locations still match - and replace the matches with the reference.
        if (opts.requireByIndex) {
            var i, stringMatch, stringRange, deps = row.deps;
            var requireMatches = detective.find(source, { ranges: true });
            for (i = requireMatches.strings.length - 1; i >= 0; i--) {
                stringMatch = requireMatches.strings[i];
                stringRange = requireMatches.stringRanges[i];
                source = source.substring(0, stringRange[0]) + '/* ' + stringMatch + ' */ ' + deps[stringMatch] + source.substring(stringRange[1]);
            }
        }

        var wrappedSource = [
            (first ? '' : ','),
            JSON.stringify(row.id),
            opts.requireByIndex ? ':' : ':[',
            'function(require,module,exports){\n',
            combineSourceMap.removeComments(source),
            '\n}',
            opts.requireByIndex ? '' : ',',
            opts.requireByIndex ? '' : JSON.stringify(row.deps || {}),
            opts.requireByIndex ? '' : ']'
        ].join('');

        this.queue(wrappedSource);
        lineno += newlinesIn(wrappedSource);
        
        first = false;
        if (row.entry && row.order !== undefined) {
            entries[row.order] = row.id;
        }
        else if (row.entry) entries.push(row.id);
    }
    
    function end () {
        if (first) this.queue(prelude);
        entries = entries.filter(function (x) { return x !== undefined });
        
        this.queue('},{},' + JSON.stringify(entries) + ')');
        if (sourcemap) this.queue('\n' + sourcemap.comment());

        this.queue(null);
    }
};
