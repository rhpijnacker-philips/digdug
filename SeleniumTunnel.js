/**
 * @module digdug/SeleniumTunnel
 */

var format = require('util').format;
var fs = require('fs');
var pathUtil = require('path');
var Promise = require('dojo/Promise');
var request = require('dojo/request');
var Tunnel = require('./Tunnel');
var util = require('./util');

/*
 * For the three included driver configs, the `platform` and `arch` properties are assumed to use values from the same
 * sets as Node's `os.platform` and `os.arch` properties.
 */

/**
 * Configuration information for the Chrome driver
 * @param {Object} options mixin properties
 * @constructor
 */
function ChromeConfig(options) {
	util.mixin(this, options);
}

ChromeConfig.prototype = {
	constructor: ChromeConfig,
	version: '2.22',
	baseUrl: 'https://chromedriver.storage.googleapis.com',
	platform: process.platform,
	arch: process.arch,
	get artifact() {
		var platform = this.platform;
		if (platform === 'linux') {
			platform = 'linux' + (this.arch === 'x64' ? '64' : '32');
		}
		else if (platform === 'darwin') {
			platform = 'mac32';
		}
		return format('chromedriver_%s.zip', platform);
	},
	get url() {
		return format('%s/%s/%s', this.baseUrl, this.version, this.artifact);
	},
	get executable() {
		return this.platform === 'win32' ? 'chromedriver.exe' : 'chromedriver';
	},
	get seleniumProperty() {
		return 'webdriver.chrome.driver';
	}
};

/**
 * Configuration information for Internet Explorer driver
 * @param {Object} options mixin properties
 * @constructor
 */
function IeConfig(options) {
	util.mixin(this, options);
}

IeConfig.prototype = {
	constructor: IeConfig,
	version: '2.53.0',
	baseUrl: 'https://selenium-release.storage.googleapis.com',
	arch: process.arch,
	get artifact() {
		var architecture = this.arch === 'x64' ? 'x64' : 'Win32';
		return format('IEDriverServer_%s_%s.zip', architecture, this.version);
	},
	get url() {
		var majorMinorVersion = this.version.slice(0, this.version.lastIndexOf('.'));
		return format('%s/%s/%s', this.baseUrl, majorMinorVersion, this.artifact);
	},
	get executable() {
		return 'IEDriverServer.exe';
	},
	get seleniumProperty() {
		return 'webdriver.ie.driver';
	}
};

/**
 * Configuration information for the Firefox driver
 * @param {Object} options mixin properties
 * @constructor
 */
function FirefoxConfig(options) {
	util.mixin(this, options);
}

FirefoxConfig.prototype = {
	constructor: FirefoxConfig,
	version: '0.9.0',
	baseUrl: 'https://github.com/mozilla/geckodriver/releases/download',
	platform: process.platform,
	get artifact() {
		var platform = this.platform;
		if (platform === 'linux') {
			platform = 'linux64';
		}
		else if (platform === 'win32') {
			platform = 'win64';
		}
		else if (platform === 'darwin') {
			platform = 'mac';
		}
		var extension = (platform === 'win64' ? '.zip' : '.tar.gz');
		return format('geckodriver-v%s-%s%s', this.version, platform, extension);
	},
	get url() {
		return format('%s/v%s/%s', this.baseUrl, this.version, this.artifact);
	},
	get executable() {
		return this.platform === 'win32' ? 'geckodriver.exe' : 'geckodriver';
	},
	get seleniumProperty() {
		return 'webdriver.gecko.driver';
	}
};

var driverNameMap = {
	chrome: ChromeConfig,
	ie: IeConfig,
	firefox: FirefoxConfig
};

/**
 * The Selenium Tunnel responsible for downloading, starting and stopping Selenium standalone
 * @constructor
 */
function SeleniumTunnel() {
	Tunnel.apply(this, arguments);
	
	if (this.drivers === null) {
		this.drivers = [ 'chrome' ];
	}
}

var _super = Tunnel.prototype;

SeleniumTunnel.prototype = util.mixin(Object.create(_super), /** @lends module:digdug/SeleniumTunnel# */ {
	constructor: SeleniumTunnel,

	/**
	 * Additional arguments to send to Selenium standalone on start
	 *
	 * @type {Array}
	 */
	seleniumArgs: null,

	/**
	 * The desired Selenium drivers to install. Each entry may be a string or an object. Strings must be the names of
	 * existing drivers in SeleniumTunnel. An object with a 'name' property is a configuration object -- the name must
	 * be the name of an existing driver in SeleniumTunnel, and the remaining properties will be used to configure that
	 * driver. An object without a 'name' property is a driver definition. It must contain three properties:
	 *
	 *   executable - the name of the driver executable
	 *   url - the URL where the driver can be downloaded from
	 *   seleniumProperty - the name of the Java property used to tell Selenium where the driver is
	 *
	 * example:
	 * 	[
	 *      'chrome',
	 *      {
	 *          name: 'firefox',
	 *          version: '0.8.0'
	 *      },
	 *      {
	 *          url: 'https://github.com/operasoftware/operachromiumdriver/releases/.../operadriver_mac64.zip',
	 *          executable: 'operadriver',
	 *          seleniumProperty: 'webdriver.opera.driver'
	 *      }
	 * 	]
	 *
	 * @type {Array}
	 * @default [ 'chrome' ]
	 */
	drivers: null,

	/**
	 * The base address where Selenium artifacts may be found.
	 *
	 * @type {string}
	 */
	baseUrl: 'https://selenium-release.storage.googleapis.com',

	/**
	 * The desired version of selenium to install.
	 *
	 * @type {string}
	 * @default
	 */
	version: '2.53.0',

	/**
	 * Timeout for communicating with Selenium Services
	 */
	serviceTimeout: 5000,

	get artifact() {
		return 'selenium-server-standalone-' + this.version + '.jar';
	},

	get directory() {
		return pathUtil.join(__dirname, 'selenium-standalone');
	},

	get executable() {
		return 'java';
	},

	get isDownloaded() {
		var directory = this.directory;
		return this._getDriverConfigs().every(function (config) {
			return util.fileExists(pathUtil.join(directory, config.executable));
		}, this) && util.fileExists(pathUtil.join(directory, this.artifact));
	},

	get url() {
		var majorMinorVersion = this.version.slice(0, this.version.lastIndexOf('.'));
		return format('%s/%s/%s', this.baseUrl, majorMinorVersion, this.artifact);
	},

	download: function (forceDownload) {
		if (!forceDownload && this.isDownloaded) {
			return Promise.resolve();
		}

		var self = this;
		return new Promise(function (resolve, reject, progress, setCanceler) {
			setCanceler(function (reason) {
				tasks && tasks.forEach(function (task) {
					task.cancel(reason);
				});
			});

			var configs = [ { url: self.url, executable: self.artifact } ];
			configs = configs.concat(self._getDriverConfigs());

			var tasks = configs.map(function (config) {
				var executable = config.executable;
				if (fs.existsSync(pathUtil.join(self.directory, executable))) {
					return Promise.resolve();
				}

				return self._downloadFile(config.url, self.proxy, {
					executable: executable
				}).then(null, null, progress);
			});
		
			resolve(Promise.all(tasks));
		});
	},

	sendJobState: function () {
		// This is a noop for Selenium
		return Promise.resolve();
	},

	_getDriverConfigs: function () {
		function getDriverConfig(name, options) {
			var Constructor = driverNameMap[name];
			if (!Constructor) {
				throw new Error('Invalid driver name "' + name + '"');
			}
			return new Constructor(options);
		}

		return this.drivers.map(function (data) {
			if (typeof data === 'string') {
				return getDriverConfig(data);
			}

			if (typeof data === 'object' && data.name) {
				return getDriverConfig(data.name, data);
			}

			// data is a driver definition
			return data;
		});
	},

	_makeArgs: function () {
		var directory = this.directory;
		var driverConfigs = this._getDriverConfigs();
		var args = [
			'-jar',
			pathUtil.join(this.directory, this.artifact),
			'-port',
			this.port
		];
		
		driverConfigs.reduce(function (args, config) {
			var file = pathUtil.join(directory, config.executable);
			args.push('-D' + config.seleniumProperty + '=' + file);
			return args;
		}, args);

		if (this.seleniumArgs) {
			args = args.concat(this.seleniumArgs);
		}

		if (this.verbose) {
			args.push('-debug');
			console.log('starting with arguments: ', args.join(' '));
		}
		
		return args;
	},

	_postDownloadFile: function (response, options) {
		if (pathUtil.extname(options.executable) === '.jar') {
			return util.writeFile(response.data, pathUtil.join(this.directory, options.executable));
		}
		return util.decompress(response.data, this.directory);
	},
	
	_start: function () {
		var self = this;
		var childHandle = this._makeChild();
		var child = childHandle.process;
		var dfd = childHandle.deferred;
		var handle = util.on(child.stderr, 'data', function (data) {
			// Selenium recommends that we poll the hub looking for a status response
			// https://github.com/seleniumhq/selenium-google-code-issue-archive/issues/7957
			// We're going against the recommendation here for a few reasons
			// 1. There's no default pid or log to look for errors to provide a specific failure
			// 2. Polling on a failed server start could leave us with an unpleasant wait
			// 3. Just polling a selenium server doesn't guarantee it's the server we started
			// 4. This works pretty well
			if (data.indexOf('Selenium Server is up and running') > -1) {
				dfd.resolve();
			}
			if (self.verbose) {
				console.log(data);
			}
		});
		var removeHandle = handle.remove.bind(handle);

		dfd.promise.then(removeHandle, removeHandle);

		return childHandle;
	},

	_stop: function () {
		var dfd = new Promise.Deferred();
		var childProcess = this._process;
		var timeout;

		childProcess.once('exit', function (code) {
			dfd.resolve(code);
			clearTimeout(timeout);
		});

		// Nicely ask the Selenium server to shutdown
		request('http://' + this.hostname + ':' + this.port +
			'/selenium-server/driver/?cmd=shutDownSeleniumServer', {
			timeout: this.seleniumTimeout,
			handleAs: 'text'
		});

		// Give Selenium a few seconds, then forcefully tell it to shutdown
		timeout = setTimeout(function () {
			childProcess.kill('SIGTERM');
		}, 5000);

		return dfd.promise;
	}
});

module.exports = SeleniumTunnel;
