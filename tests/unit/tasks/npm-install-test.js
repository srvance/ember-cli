'use strict';

const NpmInstallTask = require('../../../lib/tasks/npm-install');
const MockUI = require('console-ui/mock');
const expect = require('chai').expect;

describe('npm install task', function() {
  let npmInstallTask;
  let ui;

  beforeEach(function() {
    let project = {
      root: __dirname,
    };
    ui = new MockUI();

    npmInstallTask = new NpmInstallTask({
      ui,
      project,
    });
  });

  afterEach(function() {
    ui = undefined;
    npmInstallTask = undefined;
  });

  it('skips npm installs if there is no package.json', function() {
    npmInstallTask.run({});
    expect(ui.output).to.include('Skipping npm install: package.json not found');
  });
});
