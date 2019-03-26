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
const Lang = imports.lang;
const Search = imports.ui.search;
const Shell = imports.gi.Shell;
const St = imports.gi.St;
const Util = imports.misc.util;
const IconGrid = imports.ui.iconGrid;
const ByteArray = imports.byteArray;

// Settings
const DEFAULT_TERMINAL_SCHEMA = 'org.gnome.desktop.default-applications.terminal';
const DEFAULT_TERMINAL_KEY = 'exec';
const DEFAULT_TERMINAL_ARGS_KEY = 'exec-arg';
const SSHSEARCH_TERMINAL_APP = 'gnome-terminal';
const SSHSEARCH_TERMINAL_DESKTOP = 'org.gnome.Terminal.desktop';
const HOST_SEARCHSTRING = 'host ';

// sshSearchProvider holds the instance of the search provider
// implementation. If null, the extension is either uninitialized
// or has been disabled via disable().
var sshSearchProvider = null;

// try to find the default terminal app. fallback is gnome-terminal
function getDefaultTerminal() {
    try {
        if (Gio.Settings.list_schemas().indexOf(DEFAULT_TERMINAL_SCHEMA) == -1) {
            return {'exec': SSHSEARCH_TERMINAL_APP,
                    'args': ''
                   };
        }

        let terminal_setting = new Gio.Settings({ schema: DEFAULT_TERMINAL_SCHEMA });
        return {'exec': terminal_setting.get_string(DEFAULT_TERMINAL_KEY),
                'args': terminal_setting.get_string(DEFAULT_TERMINAL_ARGS_KEY)
               };
    } catch (err) {
        return {'exec': SSHSEARCH_TERMINAL_APP,
                'args': ''
               };
    }
}

//SshSearchProvider.prototype = {
const SshSearchProvider = class SshSearchProvider {
    constructor() {
        // Since gnome-shell 3.6 the log output is in ~/.cache/gdm/session.log
        // Since gnome-shell 3.8 the log output is in /var/log/messages
        // Since gnome-shell 3.10 you get log output with "journalctl -f"
        //log('init ssh-search');

        this.id = imports.misc.extensionUtils.getCurrentExtension().uuid;
        this.appInfo = Shell.AppSystem.get_default().lookup_app(SSHSEARCH_TERMINAL_DESKTOP).get_app_info();

        this.title = "SSHSearch";
        this._configHosts = [];
        this._knownHosts = [];
        this._sshknownHosts1 = [];
        this._sshknownHosts2 = [];
        this._terminal_definition = null;

        let filename = '';

        // init for ~/.ssh/config
        filename = GLib.build_filenamev([GLib.get_home_dir(), '/.ssh/', 'config']);
        let configFile = Gio.file_new_for_path(filename);
        this.configMonitor = configFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this.configMonitor.connect('changed', Lang.bind(this, this._onConfigChanged));
        this._onConfigChanged(null, configFile, null, Gio.FileMonitorEvent.CREATED);

        // init for ~/.ssh/known_hosts
        filename = GLib.build_filenamev([GLib.get_home_dir(), '/.ssh/', 'known_hosts']);
        let knownhostsFile = Gio.file_new_for_path(filename);
        this.knownhostsMonitor = knownhostsFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this.knownhostsMonitor.connect('changed', Lang.bind(this, this._onKnownhostsChanged));
        this._onKnownhostsChanged(null, knownhostsFile, null, Gio.FileMonitorEvent.CREATED);

        // init for /etc/ssh/ssh_known_hosts
        let sshknownhostsFile1 = Gio.file_new_for_path('/etc/ssh/ssh_known_hosts');
        this.sshknownhostsMonitor1 = sshknownhostsFile1.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this.sshknownhostsMonitor1.connect('changed', Lang.bind(this, this._onSshKnownhosts1Changed));
        this._onSshKnownhosts1Changed(null, sshknownhostsFile1, null, Gio.FileMonitorEvent.CREATED);

        // init for /etc/ssh_known_hosts
        let sshknownhostsFile2 = Gio.file_new_for_path('/etc/ssh_known_hosts');
        this.sshknownhostsMonitor2 = sshknownhostsFile2.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this.sshknownhostsMonitor2.connect('changed', Lang.bind(this, this._onSshKnownhosts2Changed));
        this._onSshKnownhosts2Changed(null, sshknownhostsFile2, null, Gio.FileMonitorEvent.CREATED);
    }

    _onConfigChanged(filemonitor, file, other_file, event_type) {
        if (!file.query_exists (null)) {
            this._configHosts = [];
            return;
        }

        if (event_type == Gio.FileMonitorEvent.CREATED ||
            event_type == Gio.FileMonitorEvent.CHANGED ||
            event_type == Gio.FileMonitorEvent.CHANGES_DONE_HINT)
        {
            this._configHosts = [];

            // read hostnames if ssh-config file is created or changed
            let content = file.load_contents(null);
            let filelines = ByteArray.toString(content[1]).trim().split('\n');

            // search for all lines which begins with "host"
            for (var i=0; i<filelines.length; i++) {
                let line = filelines[i].toLowerCase();
                if (line.lastIndexOf(HOST_SEARCHSTRING, 0) == 0) {
                    // read all hostnames in the host definition line
                    let hostnames = line.slice(HOST_SEARCHSTRING.length).split(' ');
                    for (var j=0; j<hostnames.length; j++) {
                        this._configHosts.push(hostnames[j]);
                    }
                }
            }
        }
    }

    _onKnownhostsChanged(filemonitor, file, other_file, event_type) {
        if (!file.query_exists (null)) {
            this._knownHosts = [];
            return;
        }

        if (event_type == Gio.FileMonitorEvent.CREATED ||
            event_type == Gio.FileMonitorEvent.CHANGED ||
            event_type == Gio.FileMonitorEvent.CHANGES_DONE_HINT)
        {
            this._knownHosts = this._parseKnownHosts(file);
        }
    }

    _onSshKnownhosts1Changed(filemonitor, file, other_file, event_type) {
        if (!file.query_exists (null)) {
            this._sshknownHosts1 = [];
            return;
        }

        if (event_type == Gio.FileMonitorEvent.CREATED ||
            event_type == Gio.FileMonitorEvent.CHANGED ||
            event_type == Gio.FileMonitorEvent.CHANGES_DONE_HINT)
        {
            this._sshknownHosts1 = this._parseKnownHosts(file);
        }
    }

    _onSshKnownhosts2Changed(filemonitor, file, other_file, event_type) {
        if (!file.query_exists (null)) {
            this._sshknownHosts2 = [];
            return;
        }

        if (event_type == Gio.FileMonitorEvent.CREATED ||
            event_type == Gio.FileMonitorEvent.CHANGED ||
            event_type == Gio.FileMonitorEvent.CHANGES_DONE_HINT)
        {
            this._sshknownHosts2 = this._parseKnownHosts(file);
        }
    }

    _parseKnownHosts(file) {
        let knownHosts = [];

        // read hostnames if ssh-known_hosts file is created or changed
        let content = file.load_contents(null);
        let filelines = ByteArray.toString(content[1]).trim().split('\n');

        for (var i=0; i<filelines.length; i++) {
            let hostnames = filelines[i].split(' ')[0];

            // if hostname had a 60 char length, it looks like
            // the hostname is hashed and we ignore it here
            if (hostnames[0] != '#' && (hostnames.length != 60 || hostnames.search(',') >= 0)) {
                hostnames = hostnames.split(',');
                for (var j=0; j<hostnames.length; j++) {
                    knownHosts.push(hostnames[j]);
                }
            }
        }
        return knownHosts;
    }

    createResultObject(result, terms) {
        return null;
    }

    _createIcon(size) {
        return new St.Icon({ icon_name: this._terminal_definition.exec,
                             icon_size: size });
    }

    getResultMetas(resultIds, callback) {
        this._terminal_definition = getDefaultTerminal();
        let results = [];
        for (let i = 0 ; i < resultIds.length; ++i ) {
            results.push({ 'id': resultIds[i],
                           'name': resultIds[i],
                           'createIcon': Lang.bind(this, this._createIcon)
                         });
        }
        callback(results);
    }

    activateResult(id) {
        let target = id;
        let terminal_definition = getDefaultTerminal();
        let terminal_args = terminal_definition.args.split(' ');
        let cmd = [terminal_definition.exec]

        // add defined gsettings arguments, but remove --execute and -x
        for (var i=0; i<terminal_args.length; i++) {
            let arg = terminal_args[i];

            if (arg != '--execute' && arg != '-x' && arg != '--command' && arg != '-e') {
                cmd.push(terminal_args[i]);
            }
        }

        // build command
        cmd.push('--command')

        let colonIndex = target.indexOf(':');
        let port = 22;
        if (colonIndex >= 0) {
            port = target.substr(colonIndex+1)+0;
            target = substr(target, colonIndex);
        }

        if (port == 22) {
            // don't call with the port option, because the host definition
            // could be from the ~/.ssh/config file
            cmd.push('ssh ' + target);
        }
        else {
            cmd.push('ssh -p ' + id.port + ' ' + target);
        }

        // start terminal with ssh command
        Util.spawn(cmd);
    }

    _checkHostnames(resultsDict, hostnames, terms) {
        for (var i=0; i<hostnames.length; i++) {
            for (var j=0; j<terms.length; j++) {
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

    filterResults(providerResults, maxResults) {
        return providerResults;
    }

    _getResultSet(sessions, terms) {
        // check if a found host-name begins like the search-term
        let resultsDict = {};
        let res = terms.map(function (term) { return new RegExp(term, 'i'); });

        this._checkHostnames(resultsDict, this._configHosts, terms);
        this._checkHostnames(resultsDict, this._knownHosts, terms);
        this._checkHostnames(resultsDict, this._sshknownHosts1, terms);
        this._checkHostnames(resultsDict, this._sshknownHosts2, terms);

        let results = [];
        for (let i in resultsDict) {
            results.push(i);
        }
        return results;
    }

    getInitialResultSet(terms, cb) {
        cb(this._getResultSet(null, terms));
    }

    getSubsearchResultSet(previousResults, terms, cb) {
        cb(this._getResultSet(null, terms));
    }
};

function init() {
}

function enable() {
    if (!sshSearchProvider) {
        sshSearchProvider = new SshSearchProvider();
        Main.overview.viewSelector._searchResults._registerProvider(sshSearchProvider);
    }
}

function disable() {
    if  (sshSearchProvider) {
        Main.overview.viewSelector._searchResults._unregisterProvider(sshSearchProvider);
        sshSearchProvider.configMonitor.cancel();
        sshSearchProvider.knownhostsMonitor.cancel();
        sshSearchProvider.sshknownhostsMonitor1.cancel();
        sshSearchProvider.sshknownhostsMonitor2.cancel();
        sshSearchProvider = null;
    }
}
