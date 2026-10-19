/* Kudos Lighting Labels — tesseract.js worker wrapper.
   Some hosts (the claude.ai preview among them) will not serve a .gz file, so the English data ships as
   base64 text (eng.traineddata.gz.b64.txt). This wrapper answers tesseract's request for eng.traineddata.gz
   with those bytes, then loads the real worker. */
(function () {
  var realFetch = self.fetch.bind(self);
  self.fetch = function (url, opts) {
    var u = String(url);
    if (/\/eng\.traineddata\.gz$/.test(u)) {
      return realFetch(u + '.b64.txt').then(function (r) {
        if (!r.ok) throw new Error('Could not load the text-reading data (' + r.status + ')');
        return r.text();
      }).then(function (b64) {
        var bin = atob(b64.trim()), out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return new Response(out);
      });
    }
    return realFetch(url, opts);
  };
})();
importScripts('worker.min.js');
