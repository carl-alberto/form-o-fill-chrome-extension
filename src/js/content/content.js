/*global FormFiller, JSONF, jQuery, Logger, Libs */
/*eslint complexity:0 */

// This listens for messages coming from the background page
// This is a long running communication channel
chrome.runtime.onConnect.addListener(function (port) {
  var errors = [];
  var currentError = null;
  var workingOverlayId = "form-o-fill-working-overlay";

  var workingTimeout = null;
  var takingLongTimeout = null;
  var wontFinishTimeout = null;
  var displayTimeout = null;

  Logger.info("[content.js] Got a connection from " + port.name);

  if (port.name !== "FormOFill") {
    return;
  }

  // Returns the HTML used for the throbbing overlay
  var overlayHtml = function(text, isVisible) {
    if (typeof text === "undefined") {
      text = chrome.i18n.getMessage("content_fof_is_working");
    }

    if (typeof isVisible === "undefined") {
      isVisible = false;
    }
    return "<div id='" + workingOverlayId + "' style='display: " + (isVisible ? "block" : "none") + ";'>" + text + "</div>";
  };

  // Hide overlay and cancel all timers
  var hideOverlay = function() {
    jQuery("#" + workingOverlayId).remove();
    clearTimeout(workingTimeout);
    clearTimeout(takingLongTimeout);
    clearTimeout(wontFinishTimeout);
    clearTimeout(displayTimeout);
  };

  // Shows and hides a customized overlay throbber
  var showOverlay = function(message) {
    hideOverlay();
    jQuery("body").find("#" + workingOverlayId).remove().end().append(overlayHtml(message, true));
    displayTimeout = setTimeout(hideOverlay, 3000);
  };

  // Connect to background.js which opens a long running port connection
  port.onMessage.addListener(function (message) {
    Logger.info("[content.js] Got message via port.onMessage : " + JSONF.stringify(message) + " from bg.js");

    // Request to fill one field with a value
    if (message.action === "fillField" && message.selector && message.value) {
      Logger.info("[content.js] Filling " + message.selector + " with value " + JSONF.stringify(message.value) + "; flags : " + JSONF.stringify(message.flags));

      // REMOVE START
      if (message.within && message.within !== null) {
        Logger.info("[content.js] Using within selector " + message.within);
      }

      if (message.beforeData && message.beforeData !== null) {
        Logger.info("[content.js] Also got beforeData = " + JSONF.stringify(message.beforeData));
      }
      // REMOVE END

      currentError = FormFiller.fill(message.selector, message.value, message.beforeData, message.flags, message.meta);

      // Remember the error
      if (typeof currentError !== "undefined" && currentError !== null) {
        Logger.info("[content.js] Got error " + JSONF.stringify(currentError));
        errors.push(currentError);
      }

      // Send a message that we are done filling the form
      if (message.meta.lastField) {
        Logger.info("[content.js] Sending fillFieldFinished since we are done with the last field definition");

        chrome.runtime.sendMessage({
          "action": "fillFieldFinished",
          "errors": JSONF.stringify(errors)
        });
      }
    }

    // request to return all accumulated errors
    if (message.action === "getErrors") {
      Logger.info("[content.js] Returning " + errors.length + " errors to bg.js");
      var response = {
        "action": "getErrors",
        "errors": JSONF.stringify(errors)
      };
      port.postMessage(response);
    }

    // Show Working overlay
    // This should only be triggered for the default "WORKING"
    // overlay.
    // For the customized Lib.halt() message see down below
    if (message.action === "showOverlay" && typeof message.message === "undefined") {
      Logger.info("[content.js] Showing working overlay");
      if (document.querySelectorAll("#" + workingOverlayId).length === 0) {
        jQuery("body").append(overlayHtml());
      }

      // Show working overlay after some time
      workingTimeout = setTimeout(function() {
        jQuery("#" + workingOverlayId).show();
      }, 350);

      // Show another overlay when things take REALLY long to finish
      takingLongTimeout = setTimeout(function () {
        jQuery("#" + workingOverlayId).html(chrome.i18n.getMessage("content_fof_is_working_2"));
      }, 5000);

      // Finally if everything fails, clear overlay after 12 seconds
      wontFinishTimeout = setTimeout(hideOverlay, 12000);
    }

    // Hide the overlay
    if (message.action === "hideWorkingOverlay") {
      Logger.info("[content.js] Hiding working overlay");
      hideOverlay();
    }

    // Show a custom message
    if (message.action === "showMessage" && typeof message.message !== "undefined") {
      showOverlay(message.message);
    }

    // Reload the libraries
    if (message.action === "reloadLibs") {
      Libs.import();
    }

    // Execute setupContent function
    // It has jQuery available
    if (message.action === "setupContent" && message.value) {
      Logger.info("[content.js] Executing setupContent function", message.value);

      // Parse and execute function
      var error = null;

      try {
        JSONF.parse(message.value)();
      } catch (e) {
        Logger.error("[content.js] error while executing setupContent function");
        error = e.message;
      }

      port.postMessage({action: "setupContentDone", value: JSONF.stringify(error)});
    }

    // Execute teardownContent function
    // It has jQuery available and the context object from value functions and setupContent
    if (message.action === "teardownContent" && message.value) {
      Logger.info("[content.js] Executing teardownContent function", message.value);

      try {
        JSONF.parse(message.value)();
      } catch (e) {
        Logger.error("[content.js] error while executing teardownContent function");
      }
    }
  });

  // Simple one-shot callbacks
  chrome.runtime.onMessage.addListener(function (message, sender, responseCb) {
    Logger.info("[content.js] Got message via runtime.onMessage : " + JSONF.stringify(message) + " from bg.j");

    // This is the content grabber available as context.findHtml() in before functions
    if (message.action === "grabContentBySelector") {
      Logger.info("[content.js] Grabber asked for '" + message.message + "'");
      var domElements = jQuery(message.message).map(function (index, $el) {
        return $el;
      });
      if (domElements.length === 0) {
        responseCb([]);
      } else if (domElements.length === 1) {
        responseCb(domElements[0].outerHTML);
      } else {
        responseCb(domElements.map(function(el) {
          return el.outerHTML;
        }));
      }
    }

    // Show a custom message
    // This appears twice in c/content.js because it uses a port and a one-shot
    // listener
    if (message.action === "showOverlay" && typeof message.message !== "undefined") {
      showOverlay(message.message);
      responseCb();
    }

    // Save a variable set in background via storage.set in the context of the content script
    // This makes the storage usable in value functions
    if (message.action === "storageSet" && typeof message.key !== "undefined" && typeof message.value !== "undefined") {
      Logger.info("[content.js] Saving " + message.key + " = " + message.value);
      window.sessionStorage.setItem(message.key, message.value);
    }

    // Inject a <script> tag into the page which gets executed and replaces itself with the JSON serialized
    // data the user wants.
    // <script id="fof-get-variable-some-name">{data: { some: "JSON" }}</script>
    // Only works with simple data, not functions :(
    if (message.action === "getVar" && typeof message.key !== "undefined") {
      var id = "fof-get-variable-" + message.key.replace(/[^a-zA-Z0-9_-]/g, "-");

      // Insert the node only if not present
      if (document.querySelectorAll("#" + id).length === 0) {
        var elem = document.createElement("script");
        elem.id = id;
        elem.type = "text/javascript";
        elem.dataset.purpose = "Used by Form-O-Fill to access JS variables on the site.";
        elem.className = "fof-get-variable";
        document.head.appendChild(elem);
        elem.innerHTML = "var c = '**JSONF-UNDEFINED**'; try { c = JSON.stringify(" + message.key + "); } catch(e) {}; document.querySelector('#" + id + "').innerHTML = c;";
      }

      // Now return the JSON to the caller
      var jsonNode = document.querySelector("#" + id);
      Logger.info("[content.js] getVar received " + jsonNode.innerText);
      responseCb(JSONF.parse(jsonNode.innerText));

      // ... and remove the node
      jsonNode.remove();
    }

    // Must return true to signal chrome that we do some work
    // asynchronously (see https://developer.chrome.com/extensions/runtime#event-onMessage)
    return true;
  });

});

