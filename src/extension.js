/* -*- mode: js; indent-tabs-mode: nil; js-indent-level: 4 -*-
 *
 * Ssh Search Provider for Gnome Shell
 *
 * Copyright (c) 2013 Bernd Schlapsi
 * Copyright (c) 2017-2019 Philippe Troin (F-i-f on GitHub)
 *
 * This programm is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 3 of the License, or
 * (at your option) any later version.
 *
 * This programm is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */


const Main = imports.ui.main;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Search = imports.ui.search;
const Shell = imports.gi.Shell;
const St = imports.gi.St;
const Util = imports.misc.util;
const IconGrid = imports.ui.iconGrid;
const ByteArray = imports.byteArray;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Convenience = Me.imports.convenience;

const Logger = Me.imports.logger;

// Settings
const DEFAULT_TERMINAL_SCHEMA = 'org.gnome.desktop.default-applications.terminal';
const DEFAULT_TERMINAL_KEY = 'exec';
const DEFAULT_TERMINAL_ARGS_KEY = 'exec-arg';
const FALLBACK_TERMINAL = { exec: 'gnome-terminal', args: '--', single: false };
const HOST_SEARCHSTRING = 'host ';

// ByteArray.toString() doesn't work as expected in Gnome-Shell 3.28-
// Test & provide a wrapper
var ByteArray_toString;

if (ByteArray.toString(ByteArray.fromString('X')) == 'X') {
    ByteArray_toString = function(x) {
        return ByteArray.toString(x);
    }
} else {
    ByteArray_toString = function(x) {
        return String(x);
    }
}

// A generic file, source of host names
const HostsSourceFile = class HostsSourceFile {

    constructor(logger, path) {
        this._logger = logger;
        this._path = path;
        this._file = Gio.file_new_for_path(this._path);
        this._monitor = this._file.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._changedSignal = this._monitor.connect('changed', this.onFileChange.bind(this));
        this._hosts = [];
        this.onFileChange(this._monitor, this._file, null, Gio.FileMonitorEvent.CREATED);
    }

    cleanup() {
        this._monitor.disconnect(this._changedSignal);
        this._changedSignal = null;
        this._monitor.cancel();
        this._monitor = null;
    }

    getHosts() {
        return this._hosts;
    }

    onFileChange(filemonitor, file, other_file, event_type) {
        this._logger.log_debug('HostsSourceFile.onFileChange('+file.get_path()+')');
        if (!file.query_exists (null)) {
            this._hosts = [];
            return;
        }

        if (event_type == Gio.FileMonitorEvent.CREATED ||
            event_type == Gio.FileMonitorEvent.CHANGED ||
            event_type == Gio.FileMonitorEvent.CHANGES_DONE_HINT)
        {
            let contents = file.load_contents(null);
            let filelines = ByteArray_toString(contents[1]).trim().split('\n');
            let hosts = [];
            for (let i in this.parse(filelines)) {
                hosts.push(i);
            }
            this._hosts = hosts;
            this._logger.log_debug('HostsSourceFile.onFileChange('+file.get_path()+') = '
                                   + this._hosts.length + '[' + this._hosts + ']');
        }
    }
};

// SSH config file
const ConfigHostsSourceFile = class ConfigHostsSourceFile extends HostsSourceFile {
    parse(filelines) {
        let hostsDict = {};

        // search for all lines which begins with "host"
        for (let i=0; i<filelines.length; i++) {
            let line = filelines[i].toString();
            if (line.toLowerCase().lastIndexOf(HOST_SEARCHSTRING, 0) == 0) {
                // read all hostnames in the host definition line
                let hostnames = line.slice(HOST_SEARCHSTRING.length).split(' ');
                for (let j=0; j<hostnames.length; j++) {
                    hostsDict[hostnames[j]] = 1;
                }
            }
        }

        return hostsDict;
    }
};

// SSH Known hosts file
const SshKnownHostsSourceFile = class SshKnownHostsSourceFile extends HostsSourceFile {
    parse(filelines) {
        let hostsDict = {};

        for (let i=0; i<filelines.length; i++) {
            let hostnames = filelines[i].split(' ')[0];

            // if hostname had a 60 char length, it looks like
            // the hostname is hashed and we ignore it here
            if (hostnames[0] != '#' && (hostnames.length != 60 || hostnames.search(',') >= 0)) {
                hostnames = hostnames.split(',');
                for (let j=0; j<hostnames.length; j++) {
                    hostsDict[hostnames[j]] = 1;
                }
            }
        }

        return hostsDict;
    }
};

// The Search provider
const SshSearchProvider = class SshSearchProvider {
    constructor(extension) {
        this._settings = extension._settings;
        this._logger = extension._logger;

        this._logger.log_debug('SshSearchProvider.constructor()');

        this.id = imports.misc.extensionUtils.getCurrentExtension().uuid;
        this.appInfo = Gio.DesktopAppInfo.new(this._settings.get_string('terminal-application'));
        this.title = "SSHSearch";

        this._hostsSources = [];

        this._hostsSources.push(new ConfigHostsSourceFile(this._logger,
                                                          GLib.build_filenamev([GLib.get_home_dir(), '/.ssh/', 'config'])));
        this._hostsSources.push(new ConfigHostsSourceFile(this._logger, '/etc/ssh_config'));
        this._hostsSources.push(new ConfigHostsSourceFile(this._logger, '/etc/ssh/ssh_config'));

        this._hostsSources.push(new SshKnownHostsSourceFile(this._logger,
                                                            GLib.build_filenamev([GLib.get_home_dir(), '/.ssh/', 'known_hosts'])));
        this._hostsSources.push(new SshKnownHostsSourceFile(this._logger, '/etc/ssh_known_hosts'));
        this._hostsSources.push(new SshKnownHostsSourceFile(this._logger, '/etc/ssh/ssh_known_hosts'));

        this._terminal_definition = null;
    }

    _cleanup() {
        this._logger.log_debug('SshSearchProvider._cleanup()');

        for (let i=0; i < this._hostsSources.length; ++i ) {
            this._hostsSources[i].cleanup();
        }
    }

    // Search API
    createResultObject(result, terms) {
        // this._logger.log_debug('SshSearchProvider.createResultObject('+terms+')');
        return null;
    }

    _createIcon(size) {
        return new St.Icon({ icon_name: this._terminal_definition.exec,
                             icon_size: size });
    }

    getResultMetas(resultIds, callback) {
        this._logger.log_debug('SshSearchProvider.getResultMetas('+resultIds+')');
        this._terminal_definition = this._getDefaultTerminal();
        let results = [];
        for (let i = 0 ; i < resultIds.length; ++i ) {
            results.push({ 'id': resultIds[i],
                           'name': resultIds[i],
                           'createIcon': this._createIcon.bind(this)
                         });
        }
        callback(results);
    }

    activateResult(id) {
        this._logger.log_debug('SshSearchProvider.activateResult('+id+')');
        let target = id;
        let terminal_definition = this._getDefaultTerminal();
        let cmd = [terminal_definition.exec]
        cmd.push.apply(cmd, terminal_definition.args.trim().split(/\s+/))

        let colonIndex = target.indexOf(':');
        let port = 22;
        if (colonIndex >= 0) {
            port = target.substr(colonIndex+1)+0;
            target = target.substr(colonIndex);
        }

        let sshCmd;
        if (port == 22) {
            // don't call with the port option, because the host definition
            // could be from the ~/.ssh/config file
            sshCmd = ['ssh', target];
        }
        else {
            sshCmd = ['ssh', '-p', id.port, target];
        }

        if (terminal_definition.single) {
            cmd.push(sshCmd.join(' '));
        } else {
            cmd.push.apply(cmd, sshCmd);
        }

        // start terminal with ssh command
        this._logger.log_debug('SshSearchProvider.activateResult(): cmd='+cmd);
        Util.spawn(cmd);
    }

    filterResults(providerResults, maxResults) {
        this._logger.log_debug('SshSearchProvider.filterResults('+maxResults+')');
        return providerResults;
    }

    _getResultSet(sessions, terms) {
        // check if a found host-name begins like the search-term
        let resultsDict = {};
        let res = terms.map(function (term) { return new RegExp(term, 'i'); });

        for (let hsi=0; hsi < this._hostsSources.length; ++hsi) {
            let hostnames = this._hostsSources[hsi].getHosts();
            for (let i=0; i < hostnames.length; i++) {
                for (let j=0; j<terms.length; j++) {
                    try {
                        let term_parts = terms[j].split('@');
                        let host = term_parts[term_parts.length-1];
                        let user = '';
                        if (term_parts.length > 1) {
                            user = term_parts[0];
                        }
                        if (hostnames[i].match(host)) {
                            host = hostnames[i];
                            let port = 22;

                            // check if hostname is in the format "[ip-address]:port"
                            if (host[0] == '[') {
                                let host_port = host.slice(1).split(']:');
                                host = host_port[0];
                                port = host_port[1];
                            }

                            let ssh_name = host;
                            if (port != 22) {
                                ssh_name = ssh_name + ':' + port;
                            }
                            if (user.length != 0) {
                                ssh_name = user + '@' + ssh_name;
                            }
                            resultsDict[ssh_name] = 1;
                        }
                    }
                    catch(ex) {
                        continue;
                    }
                }
            }
        }

        let results = [];
        for (let i in resultsDict) {
            results.push(i);
        }

        this._logger.log_debug('SshSearchProvider._getResultSet('+terms+') = ' + results.length + '[' + results + ']');

        return results;
    }

    getInitialResultSet(terms, cb) {
        this._logger.log_debug('SshSearchProvider.getInitialResultSet('+terms+')');
        cb(this._getResultSet(null, terms));
    }

    getSubsearchResultSet(previousResults, terms, cb) {
        this._logger.log_debug('SshSearchProvider.getSubsearchResultSet('+terms+')');
        cb(this._getResultSet(null, terms));
    }

    // try to find the default terminal app. fallback is gnome-terminal
    _getDefaultTerminal() {
        if (this.appInfo != null) {
            return {
                exec: this.appInfo.get_string('Exec'),
                args: this._settings.get_string('terminal-application-arguments'),
                single: this._settings.get_boolean('ssh-command-single-argument')
            };
        }

        let err;
        try {
            if (Gio.Settings.list_schemas().indexOf(DEFAULT_TERMINAL_SCHEMA) == -1) {
                return FALLBACK_TERMINAL;
            }

            let terminal_setting = new Gio.Settings({ schema: DEFAULT_TERMINAL_SCHEMA });
            return {
                'exec': terminal_setting.get_string(DEFAULT_TERMINAL_KEY),
                'args': terminal_setting.get_string(DEFAULT_TERMINAL_ARGS_KEY),
                'single': false
            };
        } catch (err) {
            return FALLBACK_TERMINAL;
        }
    }
};

// The extension
const SshSearchProviderExtension = class SshSearchProviderExtension {

    constructor() {
        this._logger = null;
        this._debugSettingChangedConnection = null;
        this._onTerminalApplicationChangedSignal = null;
        this._settings = null;
        this._sshSearchProvider = null;
    }

    _on_debug_change() {
        this._logger.set_debug(this._settings.get_boolean('debug'));
        this._logger.log_debug('SshSearchProviderExtension._on_debug_change(): debug = '+this._logger.get_debug());
    }

    _on_terminal_application_change() {
        this._logger.log_debug('SshSearchProviderExtension._on_terminal_application_change()');
        this._unregisterProvider();
        this._registerProvider();
    }

    _registerProvider() {
        this._logger.log_debug('SshSearchProviderExtension._registerProvider()');
        if ( ! this._sshSearchProvider) {
            this._sshSearchProvider = new SshSearchProvider(this);
            Main.overview.viewSelector._searchResults._registerProvider(this._sshSearchProvider);
        }
    }

    enable() {

        if ( ! this._logger ) {
            this._logger = new Logger.Logger('Ssh-Search-Provider');
        }

        if ( ! this._settings ) {
            this._settings = Convenience.getSettings();
        }

        this._on_debug_change();
        this._logger.log_debug('SshSearchProviderExtension.enable()');

        if ( ! this._onDebugChangedSignal ) {
            this._onDebugChangedSignal = this._settings.connect('changed::debug', this._on_debug_change.bind(this));
        }

        if ( ! this._onTerminalApplicationChangedSignal ) {
            this._onTerminalApplicationChangedSignal = this._settings.connect('changed::terminal-application',
                                                                              this._on_terminal_application_change.bind(this));
        }

        this._registerProvider();

        this._logger.log_debug('extension enabled');
    }

    _unregisterProvider() {
        this._logger.log_debug('SshSearchProviderExtension._unregisterProvider()');
        if ( this._sshSearchProvider ) {
            Main.overview.viewSelector._searchResults._unregisterProvider(this._sshSearchProvider);
            this._sshSearchProvider._cleanup();
            this._sshSearchProvider = null;
        }
    }

    disable() {

        this._logger.log_debug('SshSearchProviderExtension.disable()');

        this._unregisterProvider();

        if ( this._onTerminalApplicationChangedSignal ) {
            this._settings.disconnect(this._onTerminalApplicationChangedSignal);
            this._onTerminalApplicationChangedSignal = null;
        }

        if (this._onDebugChangedSignal) {
            this._settings.disconnect(this._onDebugChangedSignal);
            this._onDebugChangedSignal = null;
        }

        this._settings = null;

        this._logger.log_debug('extension disabled');
        this._logger = null;
    }
};

function init() {
    return new SshSearchProviderExtension();
}
