'use strict';

const fs = require('fs-extra');
const path = require('path');
const Builder = require('../../../lib/models/builder');
const BuildCommand = require('../../../lib/commands/build');
const commandOptions = require('../../factories/command-options');
const Promise = require('../../../lib/ext/promise');
const MockProject = require('../../helpers/mock-project');
let remove = Promise.denodeify(fs.remove);
const mkTmpDirIn = require('../../../lib/utilities/mk-tmp-dir-in');
const td = require('testdouble');
const experiments = require('../../experiments');
const chai = require('../../chai');
const oneLine = require('common-tags').oneLine;
let expect = chai.expect;
let file = chai.file;

let root = process.cwd();
let tmproot = path.join(root, 'tmp');

const MockUI = require('console-ui/mock');
const Heimdall = require('heimdalljs/heimdall');
const walkSync = require('walk-sync');
const EventEmitter = require('events');
const captureExit = require('capture-exit');

describe('models/builder.js', function() {
  let addon, builder, buildResults, tmpdir;

  function setupBroccoliBuilder() {
    this.builder = {
      build() {
        return Promise.resolve('build results');
      },

      cleanup() {
        return Promise.resolve('cleanup result');
      },
    };
  }

  afterEach(function() {
    if (builder) {
      return builder.cleanup();
    }
  });

  describe('process signal listeners', function() {
    let originalListenerCounts;

    function getListenerCount(emitter, event) {
      if (emitter.listenerCount) { // Present in Node >= 4.0
        return emitter.listenerCount(event);
      } else {
        // deprecated in Node 4.0
        return EventEmitter.listenerCount(emitter, event);
      }
    }

    function getListenerCounts() {
      return {
        SIGINT: getListenerCount(process, 'SIGINT'),
        SIGTERM: getListenerCount(process, 'SIGTERM'),
        message: getListenerCount(process, 'message'),
        exit: captureExit.listenerCount(),
      };
    }

    beforeEach(function() {
      originalListenerCounts = getListenerCounts();
    });

    it('sets up listeners for signals', function() {
      builder = new Builder({
        setupBroccoliBuilder,
        project: new MockProject(),
      });

      let actualListeners = getListenerCounts();

      expect(actualListeners).to.eql({
        SIGINT: originalListenerCounts.SIGINT + 1,
        SIGTERM: originalListenerCounts.SIGTERM + 1,
        message: originalListenerCounts.message + 1,
        exit: originalListenerCounts.exit + 1,
      });
    });

    it('cleans up added listeners after `.cleanup`', function() {
      builder = new Builder({
        setupBroccoliBuilder,
        project: new MockProject(),
      });

      return builder.cleanup()
        .then(function() {
          let actualListeners = getListenerCounts();
          expect(actualListeners).to.eql(originalListenerCounts);
        })
        .finally(function() {
          // we have already called `.cleanup`, calling it again
          // in the global afterEach triggers an error
          builder = null;
        });
    });
  });

  describe('Windows CTRL + C Capture', function() {
    let originalPlatform, originalStdin;

    before(function() {
      originalPlatform = process.platform;
      originalStdin = process.platform;
    });

    after(function() {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
      });

      Object.defineProperty(process, 'stdin', {
        value: originalStdin,
      });
    });

    it('enables raw capture on Windows', function() {
      Object.defineProperty(process, 'platform', {
        value: 'win',
      });

      Object.defineProperty(process, 'stdin', {
        value: {
          isTTY: true,
        },
      });

      let trapWindowsSignals = td.function();

      builder = new Builder({
        setupBroccoliBuilder,
        trapWindowsSignals,
        project: new MockProject(),
      });

      builder.trapSignals();
      td.verify(trapWindowsSignals());
    });

    it('does not enable raw capture on non-Windows', function() {
      Object.defineProperty(process, 'platform', {
        value: 'mockOS',
      });

      Object.defineProperty(process, 'stdin', {
        value: {
          isTTY: true,
        },
      });

      let trapWindowsSignals = td.function();

      builder = new Builder({
        setupBroccoliBuilder,
        trapWindowsSignals,
        project: new MockProject(),
      });

      builder.trapSignals();
      td.verify(trapWindowsSignals(), { times: 0, ignoreExtraArgs: true });

      return builder.cleanup();
    });
  });

  describe('copyToOutputPath', function() {
    beforeEach(function() {
      return mkTmpDirIn(tmproot).then(function(dir) {
        tmpdir = dir;
        builder = new Builder({
          setupBroccoliBuilder,
          project: new MockProject(),
        });
      });
    });

    afterEach(function() {
      return remove(tmproot);
    });

    it('allows for non-existent output-paths at arbitrary depth', function() {
      builder.outputPath = path.join(tmpdir, 'some', 'path', 'that', 'does', 'not', 'exist');

      builder.copyToOutputPath('tests/fixtures/blueprints/basic_2');
      expect(file(path.join(builder.outputPath, 'files', 'foo.txt'))).to.exist;
    });

    let command;

    let parentPath = `..${path.sep}..${path.sep}`;

    before(function() {
      command = new BuildCommand(commandOptions());

      builder = new Builder({
        setupBroccoliBuilder,
        project: new MockProject(),
      });
    });

    it('when outputPath is root directory ie., `--output-path=/` or `--output-path=C:`', function() {
      let outputPathArg = '--output-path=.';
      let outputPath = command.parseArgs([outputPathArg]).options.outputPath;
      outputPath = outputPath.split(path.sep)[0] + path.sep;
      builder.outputPath = outputPath;

      expect(builder.canDeleteOutputPath(outputPath)).to.equal(false);
    });

    it('when outputPath is project root ie., `--output-path=.`', function() {
      let outputPathArg = '--output-path=.';
      let outputPath = command.parseArgs([outputPathArg]).options.outputPath;
      builder.outputPath = outputPath;

      expect(builder.canDeleteOutputPath(outputPath)).to.equal(false);
    });

    it(`when outputPath is a parent directory ie., \`--output-path=${parentPath}\``, function() {
      let outputPathArg = `--output-path=${parentPath}`;
      let outputPath = command.parseArgs([outputPathArg]).options.outputPath;
      builder.outputPath = outputPath;

      expect(builder.canDeleteOutputPath(outputPath)).to.equal(false);
    });

    it('allow outputPath to contain the root path as a substring, as long as it is not a parent', function() {
      let outputPathArg = '--output-path=.';
      let outputPath = command.parseArgs([outputPathArg]).options.outputPath;
      outputPath = outputPath.substr(0, outputPath.length - 1);
      builder.outputPath = outputPath;

      expect(builder.canDeleteOutputPath(outputPath)).to.equal(true);
    });
  });

  describe('build', function() {
    let instrumentationStart;
    let instrumentationStop;

    beforeEach(function() {
      let command = new BuildCommand(commandOptions());

      builder = new Builder({
        setupBroccoliBuilder,
        project: new MockProject(),
        processBuildResult(buildResults) { return Promise.resolve(buildResults); },
      });

      instrumentationStart = td.replace(builder.project._instrumentation, 'start');
      instrumentationStop = td.replace(builder.project._instrumentation, 'stopAndReport');
    });

    afterEach(function() {
      delete process._heimdall;
      delete process.env.BROCCOLI_VIZ;
      builder.project.ui.output = '';
    });

    it('calls instrumentation.start', function() {
      let mockAnnotation = 'MockAnnotation';
      return builder.build(null, mockAnnotation).then(function() {
        td.verify(instrumentationStart('build'), { times: 1 });
      });
    });

    it('calls instrumentation.stop(build, result, resultAnnotation)', function() {
      let mockAnnotation = 'MockAnnotation';

      return builder.build(null, mockAnnotation).then(function() {
        td.verify(instrumentationStop('build', 'build results', mockAnnotation), { times: 1 });
      });
    });

    it('prints a deprecation warning if it discovers a < v0.1.4 version of heimdalljs', function() {
      process._heimdall = {};

      return builder.build().then(function() {
        let output = builder.project.ui.output;

        expect(output).to.include('Heimdalljs < 0.1.4 found.  Please remove old versions');
      });
    });

    it('does not print a deprecation warning if it does not discover a < v0.1.4 version of heimdalljs', function() {
      expect(process._heimdall).to.equal(undefined);

      return builder.build().then(function() {
        let output = builder.project.ui.output;

        expect(output).to.not.include('Heimdalljs < 0.1.4 found.  Please remove old versions');
      });
    });
  });

  describe('addons', function() {
    let hooksCalled;
    let instrumentationArg;

    beforeEach(function() {
      instrumentationArg = undefined;
      hooksCalled = [];
      addon = {
        name: 'TestAddon',
        preBuild() {
          hooksCalled.push('preBuild');

          return Promise.resolve();
        },

        postBuild() {
          hooksCalled.push('postBuild');

          return Promise.resolve();
        },

        outputReady() {
          hooksCalled.push('outputReady');
        },

        buildError() {
          hooksCalled.push('buildError');
        },
      };

      let project = new MockProject();
      project.addons = [addon];

      builder = new Builder({
        setupBroccoliBuilder() {},
        builder: {
          build() {
            hooksCalled.push('build');

            return Promise.resolve(buildResults);
          },

          cleanup() {
            return Promise.resolve('cleanup results');
          },
        },
        processBuildResult(buildResults) { return Promise.resolve(buildResults); },
        project,
      });

      buildResults = 'build results';
    });

    afterEach(function() {
      delete process.env.BROCCOLI_VIZ;
      delete process.env.EMBER_CLI_INSTRUMENTATION;
    });

    it('allows addons to add promises preBuild', function() {
      let preBuild = td.replace(addon, 'preBuild', td.function());
      td.when(preBuild(), { ignoreExtraArgs: true, times: 1 }).thenReturn(Promise.resolve());

      return builder.build();
    });

    it('allows addons to add promises postBuild', function() {
      let postBuild = td.replace(addon, 'postBuild', td.function());

      return builder.build().then(function() {
        td.verify(postBuild(buildResults), { times: 1 });
      });
    });

    it('allows addons to add promises outputReady', function() {
      let outputReady = td.replace(addon, 'outputReady', td.function());

      return builder.build().then(function() {
        td.verify(outputReady(buildResults), { times: 1 });
      });
    });


    describe('instrumentation hooks', function() {
      beforeEach(function() {
        process.env.EMBER_CLI_INSTRUMENTATION = '1';
      });

      if (experiments.INSTRUMENTATION) {
        it('invokes the instrumentation hook if it is preset', function() {
          addon[experiments.INSTRUMENTATION] = function(instrumentation) {
            hooksCalled.push('instrumentation');
            instrumentationArg = instrumentation;
          };

          return builder.build(null, {}).then(function() {
            expect(hooksCalled).to.deep.equal(['preBuild', 'build', 'postBuild', 'outputReady', 'instrumentation']);
          });
        });
      }

      if (experiments.BUILD_INSTRUMENTATION) {
        it('throws if [BUILD_INSTRUMENTATION] is set', function() {
          addon[experiments.BUILD_INSTRUMENTATION] = function() { };

          return builder.build(null, {}).then(function() {
            throw new Error('Expected build to reject from thrown error');
          }, function(reason) {
            expect(reason.message).to.eql(oneLine`
              TestAddon defines experiments.BUILD_INSTRUMENTATION. Update to use
              experiments.INSTRUMENTATION
            `);
          });
        });
      }
    });

    it('hooks are called in the right order without visualization', function() {
      return builder.build().then(function() {
        expect(hooksCalled).to.deep.equal(['preBuild', 'build', 'postBuild', 'outputReady']);
      });
    });

    it('should call postBuild before processBuildResult', function() {
      let called = [];

      addon.postBuild = function() {
        called.push('postBuild');
      };

      builder.processBuildResult = function() {
        called.push('processBuildResult');
      };

      return builder.build().then(function() {
        expect(called).to.deep.equal(['postBuild', 'processBuildResult']);
      });
    });

    it('should call outputReady after processBuildResult', function() {
      let called = [];

      builder.processBuildResult = function() {
        called.push('processBuildResult');
      };

      addon.outputReady = function() {
        called.push('outputReady');
      };

      return builder.build().then(function() {
        expect(called).to.deep.equal(['processBuildResult', 'outputReady']);
      });
    });

    it('buildError receives the error object from the errored step', function() {
      let thrownBuildError = new Error('buildError');
      let receivedBuildError;

      addon.buildError = function(errorThrown) {
        receivedBuildError = errorThrown;
      };

      builder.builder.build = function() {
        hooksCalled.push('build');

        return Promise.reject(thrownBuildError);
      };

      return builder.build().then(function() {
        expect(false, 'should not succeed').to.be.ok;
      }).catch(function() {
        expect(receivedBuildError).to.equal(thrownBuildError);
      });
    });

    it('calls buildError and does not call build, postBuild or outputReady when preBuild fails', function() {
      addon.preBuild = function() {
        hooksCalled.push('preBuild');

        return Promise.reject(new Error('preBuild Error'));
      };

      return builder.build().then(function() {
        expect(false, 'should not succeed').to.be.ok;
      }).catch(function() {
        expect(hooksCalled).to.deep.equal(['preBuild', 'buildError']);
      });
    });

    it('calls buildError and does not call postBuild or outputReady when build fails', function() {
      builder.builder.build = function() {
        hooksCalled.push('build');

        return Promise.reject(new Error('build Error'));
      };

      return builder.build().then(function() {
        expect(false, 'should not succeed').to.be.ok;
      }).catch(function() {
        expect(hooksCalled).to.deep.equal(['preBuild', 'build', 'buildError']);
      });
    });

    it('calls buildError when postBuild fails', function() {
      addon.postBuild = function() {
        hooksCalled.push('postBuild');

        return Promise.reject(new Error('preBuild Error'));
      };

      return builder.build().then(function() {
        expect(false, 'should not succeed').to.be.ok;
      }).catch(function() {
        expect(hooksCalled).to.deep.equal(['preBuild', 'build', 'postBuild', 'buildError']);
      });
    });

    it('calls buildError when outputReady fails', function() {
      addon.outputReady = function() {
        hooksCalled.push('outputReady');

        return Promise.reject(new Error('outputReady Error'));
      };

      return builder.build().then(function() {
        expect(false, 'should not succeed').to.be.ok;
      }).catch(function() {
        expect(hooksCalled).to.deep.equal(['preBuild', 'build', 'postBuild', 'outputReady', 'buildError']);
      });
    });
  });
});
