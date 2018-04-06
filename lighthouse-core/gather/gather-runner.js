/**
 * @license Copyright 2016 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const log = require('lighthouse-logger');
const Audit = require('../audits/audit');
const LHError = require('../lib/errors');
const URL = require('../lib/url-shim');
const NetworkRecorder = require('../lib/network-recorder.js');
const constants = require('../config/constants');

const Driver = require('../gather/driver.js'); // eslint-disable-line no-unused-vars

/**
 * @typedef {{driver: Driver, url: string, settings: LH.Config.Settings}} GatherRunnerOptions
 */
/**
 * Each entry in each gatherer result array is the output of a gatherer phase:
 * `beforePass`, `pass`, and `afterPass`. Flattened into an `LH.Artifacts` in
 * `collectArtifacts`.
 * @typedef {{LighthouseRunWarnings: Array<Array<string>>, [artifactName: string]: Array<*>}} GathererResults
 */

/**
 * Class that drives browser to load the page and runs gatherer lifecycle hooks.
 * Execution sequence when GatherRunner.run() is called:
 *
 * 1. Setup
 *   A. navigate to about:blank
 *   B. driver.connect()
 *   C. GatherRunner.setupDriver()
 *     i. assertNoSameOriginServiceWorkerClients
 *     ii. beginEmulation
 *     iii. enableRuntimeEvents
 *     iv. evaluateScriptOnLoad rescue native Promise from potential polyfill
 *     v. register a performance observer
 *     vi. register dialog dismisser
 *     vii. clearDataForOrigin
 *
 * 2. For each pass in the config:
 *   A. GatherRunner.beforePass()
 *     i. navigate to about:blank
 *     ii. Enable network request blocking for specified patterns
 *     iii. all gatherers' beforePass()
 *   B. GatherRunner.pass()
 *     i. cleanBrowserCaches() (if it's a perf run)
 *     ii. beginDevtoolsLog()
 *     iii. beginTrace (if requested)
 *     iv. GatherRunner.loadPage()
 *       a. navigate to options.url (and wait for onload)
 *     v. all gatherers' pass()
 *   C. GatherRunner.afterPass()
 *     i. endTrace (if requested) & endDevtoolsLog & endThrottling
 *     ii. all gatherers' afterPass()
 *
 * 3. Teardown
 *   A. GatherRunner.disposeDriver()
 *   B. collect all artifacts and return them
 *     i. collectArtifacts() from completed passes on each gatherer
 *     ii. add trace data and computed artifact methods
 */
class GatherRunner {
  /**
   * Loads about:blank and waits there briefly. Since a Page.reload command does
   * not let a service worker take over, we navigate away and then come back to
   * reload. We do not `waitForLoad` on about:blank since a page load event is
   * never fired on it.
   * @param {Driver} driver
   * @param {string=} url
   * @param {number=} duration
   * @return {Promise<string>}
   */
  static loadBlank(
      driver,
      url = constants.defaultPassConfig.blankPage,
      duration = constants.defaultPassConfig.blankDuration
  ) {
    return driver.gotoURL(url).then(_ => new Promise(resolve => setTimeout(resolve, duration)));
  }

  /**
   * Loads options.url with specified options. If the main document URL
   * redirects, options.url will be updated accordingly. As such, options.url
   * will always represent the post-redirected URL. options.initialUrl is the
   * pre-redirect starting URL.
   * @param {Driver} driver
   * @param {LH.Gatherer.PassContext} passContext
   * @return {Promise<void>}
   */
  static loadPage(driver, passContext) {
    return driver.gotoURL(passContext.url, {
      waitForLoad: true,
      passContext,
    }).then(finalUrl => {
      passContext.url = finalUrl;
    });
  }

  /**
   * @param {Driver} driver
   * @param {GathererResults} gathererResults
   * @param {GatherRunnerOptions} options
   * @return {Promise<void>}
   */
  static setupDriver(driver, gathererResults, options) {
    log.log('status', 'Initializing…');
    const resetStorage = !options.settings.disableStorageReset;
    // Enable emulation based on settings
    return driver.assertNoSameOriginServiceWorkerClients(options.url)
      .then(_ => driver.getUserAgent())
      .then(userAgent => {
        gathererResults.UserAgent = [userAgent];
        GatherRunner.warnOnHeadless(userAgent, gathererResults);
        gathererResults.fetchedAt = [(new Date()).toJSON()];
      })
      .then(_ => driver.beginEmulation(options.settings))
      .then(_ => driver.enableRuntimeEvents())
      .then(_ => driver.cacheNatives())
      .then(_ => driver.registerPerformanceObserver())
      .then(_ => driver.dismissJavaScriptDialogs())
      .then(_ => {
        if (resetStorage) return driver.clearDataForOrigin(options.url);
      });
  }

  /**
   * @param {Driver} driver
   * @return {Promise<void>}
   */
  static disposeDriver(driver) {
    log.log('status', 'Disconnecting from browser...');
    return driver.disconnect().catch(err => {
      // Ignore disconnecting error if browser was already closed.
      // See https://github.com/GoogleChrome/lighthouse/issues/1583
      if (!(/close\/.*status: 500$/.test(err.message))) {
        log.error('GatherRunner disconnect', err.message);
      }
    });
  }

  /**
   * Test any error output from the promise, absorbing non-fatal errors and
   * throwing on fatal ones so that run is stopped.
   * @param {Promise<*>} promise
   * @return {Promise<void>}
   */
  static recoverOrThrow(promise) {
    return promise.catch(err => {
      if (err.fatal) {
        throw err;
      }
    });
  }

  /**
   * Returns an error if the original network request failed or wasn't found.
   * @param {string} url The URL of the original requested page.
   * @param {Array<LH.WebInspector.NetworkRequest>} networkRecords
   * @return {LHError|undefined}
   */
  static getPageLoadError(url, networkRecords) {
    const mainRecord = networkRecords.find(record => {
      // record.url is actual request url, so needs to be compared without any URL fragment.
      return URL.equalWithExcludedFragments(record.url, url);
    });

    let errorCode;
    let errorReason;
    if (!mainRecord) {
      errorCode = LHError.errors.NO_DOCUMENT_REQUEST;
    } else if (mainRecord.failed) {
      errorCode = LHError.errors.FAILED_DOCUMENT_REQUEST;
      errorReason = mainRecord.localizedFailDescription;
    }

    if (errorCode) {
      // @ts-ignore TODO(bckenny): fix LHError constructor/errors mismatch
      const error = new LHError(errorCode, {reason: errorReason});
      log.error('GatherRunner', error.message, url);
      return error;
    }
  }

  /**
   * Add run warning if running in Headless Chrome.
   * @param {string} userAgent
   * @param {GathererResults} gathererResults
   */
  static warnOnHeadless(userAgent, gathererResults) {
    const chromeVersion = userAgent.split(/HeadlessChrome\/(.*) /)[1];
    // Headless Chrome gained throttling support in Chrome 63.
    // https://chromium.googlesource.com/chromium/src/+/8931a104b145ccf92390f6f48fba6553a1af92e4
    const minVersion = '63.0.3239.0';
    if (chromeVersion && chromeVersion < minVersion) {
      gathererResults.LighthouseRunWarnings[0].push('Your site\'s mobile performance may be ' +
          'worse than the numbers presented in this report. Lighthouse could not test on a ' +
          'mobile connection because Headless Chrome does not support network throttling ' +
          'prior to version ' + minVersion + '. The version used was ' + chromeVersion);
    }
  }

  /**
   * Navigates to about:blank and calls beforePass() on gatherers before tracing
   * has started and before navigation to the target page.
   * @param {LH.Gatherer.PassContext} passContext
   * @param {GathererResults} gathererResults
   * @return {Promise<void>}
   */
  static beforePass(passContext, gathererResults) {
    const blockedUrls = (passContext.passConfig.blockedUrlPatterns || [])
      .concat(passContext.settings.blockedUrlPatterns || []);
    const blankPage = passContext.passConfig.blankPage;
    const blankDuration = passContext.passConfig.blankDuration;
    const pass = GatherRunner.loadBlank(passContext.driver, blankPage, blankDuration)
        // Set request blocking before any network activity
        // No "clearing" is done at the end of the pass since blockUrlPatterns([]) will unset all if
        // neccessary at the beginning of the next pass.
        .then(() => passContext.driver.blockUrlPatterns(blockedUrls))
        .then(() => passContext.driver.setExtraHTTPHeaders(passContext.settings.extraHeaders));

    return passContext.passConfig.gatherers.reduce((chain, gathererDefn) => {
      return chain.then(_ => {
        const gatherer = gathererDefn.instance;
        // Abuse the passContext to pass through gatherer options
        passContext.options = gathererDefn.options || {};
        const artifactPromise = Promise.resolve().then(_ => gatherer.beforePass(passContext));
        gathererResults[gatherer.name] = [artifactPromise];
        return GatherRunner.recoverOrThrow(artifactPromise);
      });
    }, pass);
  }

  /**
   * Navigates to requested URL and then runs pass() on gatherers while trace
   * (if requested) is still being recorded.
   * @param {LH.Gatherer.PassContext} passContext
   * @param {GathererResults} gathererResults
   * @return {Promise<void>}
   */
  static pass(passContext, gathererResults) {
    const driver = passContext.driver;
    const config = passContext.passConfig;
    const settings = passContext.settings;
    const gatherers = config.gatherers;

    const recordTrace = config.recordTrace;
    const isPerfRun = !settings.disableStorageReset && recordTrace && config.useThrottling;

    const gatherernames = gatherers.map(g => g.instance.name).join(', ');
    const status = 'Loading page & waiting for onload';
    log.log('status', status, gatherernames);

    const pass = Promise.resolve()
      // Clear disk & memory cache if it's a perf run
      .then(_ => {
        if (isPerfRun) driver.cleanBrowserCaches()
      })
      // Always record devtoolsLog
      .then(_ => driver.beginDevtoolsLog())
      // Begin tracing if requested by config.
      .then(_ => {
        if (recordTrace) driver.beginTrace(settings)
      })
      // Navigate.
      .then(_ => GatherRunner.loadPage(driver, passContext))
      .then(_ => log.log('statusEnd', status));

    return gatherers.reduce((chain, gathererDefn) => {
      return chain.then(_ => {
        const gatherer = gathererDefn.instance;
        // Abuse the passContext to pass through gatherer options
        passContext.options = gathererDefn.options || {};
        const artifactPromise = Promise.resolve().then(_ => gatherer.pass(passContext));
        gathererResults[gatherer.name].push(artifactPromise);
        return GatherRunner.recoverOrThrow(artifactPromise);
      });
    }, pass);
  }

  /**
   * Ends tracing and collects trace data (if requested for this pass), and runs
   * afterPass() on gatherers with trace data passed in. Promise resolves with
   * object containing trace and network data.
   * @param {LH.Gatherer.PassContext} passContext
   * @param {GathererResults} gathererResults
   * @return {Promise}
   */
  static afterPass(passContext, gathererResults) {
    const driver = passContext.driver;
    const config = passContext.passConfig;
    const gatherers = config.gatherers;
    const passData = {};

    let pass = Promise.resolve();
    /** @type {LHError|undefined} */
    let pageLoadError;

    if (config.recordTrace) {
      pass = pass.then(_ => {
        log.log('status', 'Retrieving trace');
        return driver.endTrace();
      }).then(traceContents => {
        // Before Chrome 54.0.2816 (codereview.chromium.org/2161583004),
        // traceContents was an array of trace events; after, traceContents is
        // an object with a traceEvents property. Normalize to object form.
        passData.trace = Array.isArray(traceContents) ?
            {traceEvents: traceContents} : traceContents;
        log.verbose('statusEnd', 'Retrieving trace');
      });
    }

    pass = pass.then(_ => {
      const status = 'Retrieving devtoolsLog and network records';
      log.log('status', status);
      const devtoolsLog = driver.endDevtoolsLog();
      const networkRecords = NetworkRecorder.recordsFromLogs(devtoolsLog);
      log.verbose('statusEnd', status);

      pageLoadError = GatherRunner.getPageLoadError(passContext.url, networkRecords);
      // If the driver was offline, a page load error is expected, so do not save it.
      if (!driver.online) pageLoadError = undefined;

      if (pageLoadError) {
        gathererResults.LighthouseRunWarnings[0].push('Lighthouse was unable to reliably load the ' +
          'page you requested. Make sure you are testing the correct URL and that the server is ' +
          'properly responding to all requests.');
      }

      // Expose devtoolsLog and networkRecords to gatherers
      passData.devtoolsLog = devtoolsLog;
      passData.networkRecords = networkRecords;
    });

    // Disable throttling so the afterPass analysis isn't throttled
    pass = pass.then(_ => driver.setThrottling(passContext.settings, {useThrottling: false}));

    pass = gatherers.reduce((chain, gathererDefn) => {
      const gatherer = gathererDefn.instance;
      const status = `Retrieving: ${gatherer.name}`;
      return chain.then(_ => {
        log.log('status', status);
        // Abuse the passContext to pass through gatherer options
        passContext.options = gathererDefn.options || {};
        // If there was a pageLoadError, fail every afterPass with it rather than bail completely.
        const artifactPromise = pageLoadError ?
          Promise.reject(pageLoadError) :
          Promise.resolve().then(_ => gatherer.afterPass(passContext, passData));
        gathererResults[gatherer.name].push(artifactPromise);
        return GatherRunner.recoverOrThrow(artifactPromise);
      }).then(_ => {
        log.verbose('statusEnd', status);
      });
    }, pass);

    // Resolve on tracing data using passName from config.
    return pass.then(_ => passData);
  }

  /**
   * Takes the results of each gatherer phase for each gatherer and uses the
   * last produced value (that's not undefined) as the artifact for that
   * gatherer. If a non-fatal error was rejected from a gatherer phase,
   * uses that error object as the artifact instead.
   * @param {GathererResults} gathererResults
   * @return {Promise<{[artifactName: string]: *}>}
   */
  static collectArtifacts(gathererResults) {
    const artifacts = {};

    // Nest LighthouseRunWarnings, if any, so they will be collected into artifact.
    const uniqueWarnings = Array.from(new Set(gathererResults.LighthouseRunWarnings[0]));
    gathererResults.LighthouseRunWarnings = [uniqueWarnings];

    /** @type {Array<Error>} */
    const pageLoadFailures = [];
    return Object.keys(gathererResults).reduce((chain, gathererName) => {
      return chain.then(_ => {
        const phaseResultsPromises = gathererResults[gathererName];
        return Promise.all(phaseResultsPromises).then(phaseResults => {
          // Take last defined pass result as artifact.
          const definedResults = phaseResults.filter(element => element !== undefined);
          const artifact = definedResults[definedResults.length - 1];
          if (artifact === undefined) {
            throw new Error(`${gathererName} failed to provide an artifact.`);
          }
          artifacts[gathererName] = artifact;
        }, err => {
          // To reach this point, all errors are non-fatal, so return err to
          // runner to handle turning it into an error audit.
          artifacts[gathererName] = err;
          // Track page load errors separately, so we can fail loudly if needed.
          if (LHError.isPageLoadError(err)) pageLoadFailures.push(err);
        });
      });
    }, Promise.resolve()).then(_ => {
      // Fail the run if more than 50% of all artifacts failed due to page load failure.
      if (pageLoadFailures.length > Object.keys(artifacts).length * 0.5) {
        throw pageLoadFailures[0];
      }

      return artifacts;
    });
  }

  /**
   * @param {Array<LH.Config.Pass>} passes
   * @param {GatherRunnerOptions} options
   * @return {Promise<LH.Artifacts>}
   */
  static run(passes, options) {
    const driver = options.driver;
    const tracingData = {
      /** @type {Object<string, LH.Trace>} */
      traces: {},
      /** @type {Object<string, LH.Protocol.RawEventMessage>} */
      devtoolsLogs: {},
    };

    /** @type {GathererResults} */
    const gathererResults = {
      LighthouseRunWarnings: [[]],
    };

    // @ts-ignore
    return driver.connect()
      .then(_ => GatherRunner.loadBlank(driver))
      .then(_ => GatherRunner.setupDriver(driver, gathererResults, options))

      // Run each pass
      .then(_ => {
        // If the main document redirects, we'll update this to keep track
        let urlAfterRedirects = options.url;
        return passes.reduce((chain, passConfig, passIndex) => {
          const passContext = Object.assign({}, options, {passConfig});
          return chain
            .then(_ => driver.setThrottling(options.settings, passConfig))
            .then(_ => GatherRunner.beforePass(passContext, gathererResults))
            .then(_ => GatherRunner.pass(passContext, gathererResults))
            .then(_ => GatherRunner.afterPass(passContext, gathererResults))
            .then(passData => {
              const passName = passConfig.passName || Audit.DEFAULT_PASS;

              // networkRecords are discarded and not added onto artifacts.
              tracingData.devtoolsLogs[passName] = passData.devtoolsLog;

              // If requested by config, add trace to pass's tracingData
              if (passConfig.recordTrace) {
                tracingData.traces[passName] = passData.trace;
              }

              if (passIndex === 0) {
                urlAfterRedirects = passContext.url;
              }
            });
        }, Promise.resolve()).then(_ => {
          options.url = urlAfterRedirects;
        });
      })
      .then(_ => GatherRunner.disposeDriver(driver))
      .then(_ => GatherRunner.collectArtifacts(gathererResults))
      .then(artifacts => {
        // Add tracing data and settings used to the artifacts object.
        return Object.assign(/** @type {LH.Artifacts} */artifacts, tracingData, {settings: options.settings});
      })
      // cleanup on error
      .catch(err => {
        GatherRunner.disposeDriver(driver);

        throw err;
      });
  }
}

module.exports = GatherRunner;
