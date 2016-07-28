const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const AppNotifications = imports.appNotifications;
const ChatroomManager = imports.chatroomManager;
const LogManager = imports.logManager;
const JoinDialog = imports.joinDialog;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const RoomList = imports.roomList;
const RoomStack = imports.roomStack;
//const ResultStack = imports.resultStack;
const UserList = imports.userList;
const Utils = imports.utils;
const Pango = imports.gi.Pango;
const ChatView = imports.chatView;
const ResultList = imports.resultList;
const ResultView = imports.resultView;
const ResultStack = imports.resultStack;

const CONFIGURE_TIMEOUT = 100; /* ms */


const FixedSizeFrame = new Lang.Class({
    Name: 'FixedSizeFrame',
    Extends: Gtk.Frame,
    Properties: {
        height: GObject.ParamSpec.int('height',
                                      'height',
                                      'height',
                                      GObject.ParamFlags.READWRITE,
                                      -1, GLib.MAXINT32, -1),
        width: GObject.ParamSpec.int('width',
                                     'width',
                                     'width',
                                     GObject.ParamFlags.READWRITE,
                                     -1, GLib.MAXINT32, -1)
    },

    _init: function(params) {
        this._height = -1;
        this._width = -1;

        this.parent(params);
    },

    _queueRedraw: function() {
        let child = this.get_child();
        if (child)
            child.queue_resize();
        this.queue_draw();
    },

    get height() {
        return this._height;
    },

    set height(height) {
        if (height == this._height)
            return;
        this._height = height;
        this.notify('height');
        this.set_size_request(this._width, this._height);
        this._queueRedraw();
    },

    get width() {
        return this._width;
    },

    set width(width) {
        if (width == this._width)
            return;

        this._width = width;
        this.notify('width');
        this.set_size_request(this._width, this._height);
        this._queueRedraw();
    },

    vfunc_get_preferred_width_for_height: function(forHeight) {
        let [min, nat] = this.parent(forHeight);
        return [min, this._width < 0 ? nat : this._width];
    },

    vfunc_get_preferred_height_for_width: function(forWidth) {
        let [min, nat] = this.parent(forWidth);
        return [min, this._height < 0 ? nat : this._height];
    }
});

const MainWindow = new Lang.Class({
    Name: 'MainWindow',
    Extends: Gtk.ApplicationWindow,
    Template: 'resource:///org/gnome/Polari/ui/main-window.ui',
    InternalChildren: ['titlebarRight',
                       'titlebarLeft',
                       'joinButton',
                       'search-active-button',
                        'search-bar',
                        'search-entry',
                       'showUserListButton',
                       'userListPopover',
                       'roomListRevealer',
                       'overlay',
                       'roomStack',
                       'mainStack',
                       'results',
                       'mainStack1',
                       'resultscroll'],
    Properties: {
        subtitle: GObject.ParamSpec.string('subtitle',
                                           'subtitle',
                                           'subtitle',
                                           GObject.ParamFlags.READABLE,
                                           ''),
        'subtitle-visible': GObject.ParamSpec.boolean('subtitle-visible',
                                                      'subtitle-visible',
                                                      'subtitle-visible',
                                                      GObject.ParamFlags.READABLE,
                                                      false),
        'search-active': GObject.ParamSpec.boolean(
            'search-active', '', '',
            GObject.ParamFlags.READABLE | GObject.ParamFlags.WRITABLE, false),
        'mode' : GObject.ParamSpec.string('mode',
                                          'mode',
                                          'mode',
                                          GObject.ParamFlags.READABLE,
                                          'chat')
    },

    _init: function(params) {
        this._subtitle = '';
        this._mode = 'chat';
        params.show_menubar = false;

        this.parent(params);

        this._addApplicationStyle();

        this._searchActive = false;

        this._room = null;
        this._settings = new Gio.Settings({ schema_id: 'org.gnome.Polari' });
        this._gtkSettings = Gtk.Settings.get_default();

        this._displayNameChangedId = 0;
        this._topicChangedId = 0;
        this._membersChangedId = 0;

        this._currentSize = [-1, -1];
        this._isMaximized = false;
        this._isFullscreen = false;

        let app = this.application;
        this._overlay.add_overlay(app.notificationQueue);
        this._overlay.add_overlay(app.commandOutputQueue);

        // command output notifications should not pop up over
        // the input area, but appear to emerge from it, so
        // set up an appropriate margin
        this._roomStack.bind_property('entry-area-height',
                                      app.commandOutputQueue, 'margin-bottom',
                                      GObject.BindingFlags.SYNC_CREATE);

        // Make sure user-list button is at least as wide as icon buttons
        this._joinButton.connect('size-allocate', Lang.bind(this,
            function(w, rect) {
                let width = rect.width;
                Mainloop.idle_add(Lang.bind(this, function() {
                    this._showUserListButton.width_request = width;
                    return GLib.SOURCE_REMOVE;
                }));
            }));

        this._accountsMonitor = AccountsMonitor.getDefault();
        this._accountsMonitor.connect('accounts-changed', Lang.bind(this,
            function(am) {
                let accounts = am.dupAccounts();
                this._roomListRevealer.reveal_child = accounts.some(function(a) {
                    return a.enabled;
                });
            }));

        this._roomManager = ChatroomManager.getDefault();
        this._roomManager.connect('active-changed',
                                  Lang.bind(this, this._activeRoomChanged));
        this._roomManager.connect('active-state-changed',
                                  Lang.bind(this, this._updateUserListLabel));

        this._updateUserListLabel();

        this._userListAction = app.lookup_action('user-list');

        app.connect('action-state-changed::user-list', Lang.bind(this,
            function(group, actionName, value) {
                this._userListPopover.visible = value.get_boolean();
            }));
        this._userListPopover.connect('notify::visible', Lang.bind(this,
            function() {
                if (!this._userListPopover.visible)
                    this._userListAction.change_state(GLib.Variant.new('b', false));
            }));

        this._gtkSettings.connect('notify::gtk-decoration-layout',
                                  Lang.bind(this, this._updateDecorations));
        this._updateDecorations();

        this.connect('window-state-event',
                            Lang.bind(this, this._onWindowStateEvent));
        this.connect('size-allocate',
                            Lang.bind(this, this._onSizeAllocate));
        this.connect('delete-event',
                            Lang.bind(this, this._onDelete));
        // this.connect('key-press-event', Lang.bind(this, this._handleKeyPress));

        // search start
        this._keywords = [];
        this._cancellable  = new Gio.Cancellable();
        this._widgetMap = {};
        // Utils.initActions(this,
        //                  [
        //                   { name: 'search-active',
        //                     activate: this._toggleSearch,
        //                     parameter_type: new GLib.VariantType('b'),
        //                     state: new GLib.Variant('b', false) }
        //                  ]);
        this.bind_property('search-active', this._search_active_button, 'active',
                           GObject.BindingFlags.SYNC_CREATE |
                           GObject.BindingFlags.BIDIRECTIONAL);
        this.bind_property('search-active',
                           this._search_bar,
                           'search-mode-enabled',
                           GObject.BindingFlags.SYNC_CREATE |
                           GObject.BindingFlags.BIDIRECTIONAL);
        this._search_bar.connect_entry(this._search_entry);
        this._search_entry.connect('search-changed',
                                   Lang.bind(this, this._handleSearchChanged));

        this._searchisActive = false;

        this._search_active_button.connect(
            'toggled',
            Lang.bind(this, function() {
                // if (this._mainStack.visible_child_name == 'image') {
                //     this._mainStack.visible_child_name = 'roomList';
                //     this._mainStack1.visible_child_name = 'room';
                // }
                // else {
                //     this._mainStack.visible_child_name = 'image';
                //     this._mainStack1.visible_child_name = 'result';
                // }
                this._searchisActive = !this._searchisActive;
            }));

        // this._results.connect('row-activated', Lang.bind(this, this._rowactivated));
        this._resultStack = this._resultscroll._view;
        print(this._resultStack);
        print(this._resultscroll);
        // this._resultscroll.connect('edge-reached', Lang.bind(this, this._onScroll));

        //test
        this._logManager = LogManager.getDefault();
        let query = "select ?text as ?mms where { ?msg a nmo:IMMessage; nie:plainTextContent ?text. ?msg nmo:communicationChannel ?channel. ?channel nie:title '#tracker'. ?msg nmo:from ?contact. ?contact nco:nickname 'bijan' . ?msg fts:match 'wonderful' }"
        let query1 = "select ?msg as ?id ?nick as ?name ?text as ?mms where { ?msg a nmo:IMMessage; nie:plainTextContent ?text. ?msg nmo:communicationChannel ?channel. ?channel nie:title '#tracker'. ?msg nmo:from ?contact. ?contact nco:nickname ?nick }"
        //this._logManager.query(query1,null,Lang.bind(this, this._Log));
        log("hello");
        //test
        // search end

        let size = this._settings.get_value('window-size').deep_unpack();
        if (size.length == 2)
            this.set_default_size.apply(this, size);

        if (this._settings.get_boolean('window-maximized'))
            this.maximize();

        this._mainStack.visible_child_name = 'roomList';

        this.show_all();
    },

    _rowactivated: function(box, row) {
        this._cancellable.cancel();
        this._cancellable.reset();
        let sparql = (
            'select nie:plainTextContent(?msg) as ?message ' +
            '       if (nmo:from(?msg) = nco:default-contact-me,' +
            '           "%s", nco:nickname(nmo:from(?msg))) as ?sender ' +
            // FIXME: how do we handle the "real" message type?
            '       %d as ?messageType ' +
            '       ?timestamp ' +
            '{ ?msg a nmo:IMMessage; ' +
            '       nie:contentCreated ?timestamp; ' +
            '       nmo:communicationChannel ?chan . ' +
            'BIND( ?timestamp - %s as ?timediff ) . ' +
            // FIXME: filter by account
            '  filter (nie:title (?chan) = "%s" && ?timediff >= 0) ' +
            '} order by asc (?timediff)'
        ).format(row.nickname,
                 Tp.ChannelTextMessageType.NORMAL,
                 row.timestamp,
                 row.channel);
        log(sparql);
        let sparql1 = (
            'select nie:plainTextContent(?msg) as ?message ' +
            '       if (nmo:from(?msg) = nco:default-contact-me,' +
            '           "%s", nco:nickname(nmo:from(?msg))) as ?sender ' +
            // FIXME: how do we handle the "real" message type?
            '       %d as ?messageType ' +
            '       ?timestamp ' +
            '{ ?msg a nmo:IMMessage; ' +
            '       nie:contentCreated ?timestamp; ' +
            '       nmo:communicationChannel ?chan . ' +
            'BIND( %s - ?timestamp as ?timediff ) . ' +
            // FIXME: filter by account
            '  filter (nie:title (?chan) = "%s" && ?timediff > 0) ' +
            '} order by asc (?timediff)'
        ).format(row.nickname,
                 Tp.ChannelTextMessageType.NORMAL,
                 row.timestamp,
                 row.channel);
        // let logManager = LogManager.getDefault();
        // this._logWalker = logManager.walkEvents(row,
        //                                         row.channel);
        //
        // this._fetchingBacklog = true;
        // this._logWalker.getEvents(10,
        //                           Lang.bind(this, this._onLogEventsReady));
        // this._logManager.query(sparql,this._cancellable,Lang.bind(this, this._onLogEventsReady));
        // this._logManager.query(sparql1,this._cancellable,Lang.bind(this, this._onLogEventsReady1));
        let buffer = this._resultStack.get_buffer();
        let iter = buffer.get_end_iter();
        buffer.set_text("",-1);
        this._endQuery = new LogManager.GenericQuery(this._logManager._connection, 10);
        this._endQuery.run(sparql,this._cancellable,Lang.bind(this, this._onLogEventsReady));
        log("!");
        this._startQuery = new LogManager.GenericQuery(this._logManager._connection, 15);
        // Mainloop.timeout_add(500, Lang.bind(this,
        //     function() {
        //         query.run(sparql1,this._cancellable,Lang.bind(this, this._onLogEventsReady1));
        //         return GLib.SOURCE_REMOVE;
        //     }));
        this._startQuery.run(sparql1,this._cancellable,Lang.bind(this, this._onLogEventsReady1));
        //print(this._endQuery.isClosed());

        // Mainloop.timeout_add(5000, Lang.bind(this,
        //     function() {
        //         query.next(200,this._cancellable,Lang.bind(this, this._onLogEventsReady1));
        //     }));
        // query.next(20,this._cancellable,Lang.bind(this, this._onLogEventsReady1));

        //this._resultStack.buffer.insert(iter,row._content_label.label, -1);
        // this._resultStack.label = row._content_label.label;
    },

    _onLogEventsReady: function(events) {
        this._resultscroll._query = this._endQuery;
        this._resultscroll._onLogEventsReady1(events);
        return;
        let buffer = this._resultStack.get_buffer();
        //buffer.set_text("",-1);
        for (let i = 0; i < events.length; i++) {

            let iter = buffer.get_end_iter();
            this._resultStack.buffer.insert(iter,events[i].timestamp + "\t\t\t" + events[i].sender + " : " + events[i].message, -1);
            this._resultStack.buffer.insert(iter,'\n', -1);
        }
    },

    _onLogEventsReady1: function(events) {
        this._resultscroll._query = this._startQuery;
        this._resultscroll._onLogEventsReady(events);
        return;
        log("HERE");
        let buffer = this._resultStack.get_buffer();
        // buffer.set_text("",-1);
        let iter = buffer.get_start_iter();
        // this._resultStack.buffer.insert(iter,'\n', -1);
        iter = buffer.get_start_iter();
        for (let i = 0; i < events.length; i++) {
            iter = buffer.get_start_iter();
            this._resultStack.buffer.insert(iter,'\n', -1);
            iter = buffer.get_start_iter();
            this._resultStack.buffer.insert(iter,events[i].timestamp + "\t\t\t" + events[i].sender + " : " + events[i].message, -1);
        }
    },


    _Log: function(events) {
        log(events.length);
        let widgetMap = {};
        let markup_message = '';
        for (let i = 0; i < events.length; i++) {
            let time = events[i].timestamp;
            let channel = events[i].chan;
            let message = GLib.markup_escape_text(events[i].mms, -1);
            let rawmessage = events[i].mms;
            let uid = events[i].id;
            let index = message.indexOf(this._keywords[0]);
            let row;
            row = this._widgetMap[uid];
            for (let j = 0; j < this._keywords.length; j++) {
                // log(this._keywords[j]);
                index = Math.min(index, message.indexOf(this._keywords[j]));
            //    message = message.replace( new RegExp( "(" + this._keywords[j] + ")" , 'gi' ),"<span font_weight='bold'>$1</span>");
                // print(message);
            }

            if (row) {
                log("REUSING!!!");
                widgetMap[uid] = row;
                this._results.remove(row);
            } else {
                row = new ResultList.ResultRow();
                row._source_name.label = channel.substring(1);
                row._short_time_label.label = this._formatTimestamp(time);
                row.uid = events[i].id;
                row.channel = channel;
                row.nickname = channel;
                row.timestamp = time;
                row.rawmessage = rawmessage;
                widgetMap[uid] = row;
            }
            row._content_label.label = message;
            // widgetMap[uid].get_children()[0].label = "..." + message.substring(index - 6);
        }

        this._widgetMap = widgetMap;

        this._results.foreach(r => { r.destroy(); })

        for (let i = 0; i < events.length; i++) {
            let row = this._widgetMap[events[i].id];
            // row.get_children()[0].label = markup_message;
            this._results.add(row);
        }
    },

    _Log1: function() {
        this._results.foreach(r => { r.destroy(); })
    },

    _onScroll: function(w, pos) {
        log(pos);
        if(pos==Gtk.PositionType.TOP) {
            print("called top");
            Mainloop.timeout_add(500, Lang.bind(this,
                function() {
                    this._startQuery.next(10,this._cancellable,Lang.bind(this, this._onLogEventsReady1));
                }));
            return;
        }
        if(pos==Gtk.PositionType.BOTTOM) {
            print("called bottom");
            Mainloop.timeout_add(500, Lang.bind(this,
                function() {
                    this._endQuery.next(10,this._cancellable,Lang.bind(this, this._onLogEventsReady));
                }));
        }
    },

    get subtitle() {
        return this._subtitle;
    },

    get subtitle_visible() {
        return this._subtitle.length > 0;
    },

    get mode() {
        return this._mode;
    },

    _handleSearchChanged: function(entry) {
        let text = entry.get_text().replace(/^\s+|\s+$/g, '');
        let app = this.application;
        let action = app.lookup_action('search-terms');
        action.change_state(GLib.Variant.new('s', text));
        if(text!='') {
            this._mode='search';
        } else {
            this._mode='chat';
        }
        this.notify('mode');
        return;
        this._cancellable.cancel();
        this._cancellable.reset();
//         if(text!='' && this._searchActive) {
//                         this._mainStack.visible_child_name = 'image';
// }
// else {
//     this._mainStack.visible_child_name = 'roomList';
// }
        let text = entry.get_text().replace(/^\s+|\s+$/g, '');
        this._keywords = text == '' ? [] : text.split(/\s+/);
        log(text);
        let query1 = ("select ?text as ?mms ?msg as ?id ?chan as ?chan ?timestamp as ?timestamp where { ?msg a nmo:IMMessage . ?msg nie:plainTextContent ?text . ?msg fts:match '%s*' . ?msg nmo:communicationChannel ?channel. ?channel nie:title ?chan. ?msg nie:contentCreated ?timestamp }").format(text);
        log(query1);
        this._logManager.query(query1,this._cancellable,Lang.bind(this, this._Log));
    },

    _formatTimestamp: function(timestamp) {
        let date = GLib.DateTime.new_from_unix_local(timestamp);
        let now = GLib.DateTime.new_now_local();

        // 00:01 actually, just to be safe
        let todayMidnight = GLib.DateTime.new_local(now.get_year(),
                                                    now.get_month(),
                                                    now.get_day_of_month(),
                                                    0, 1, 0);
        let dateMidnight = GLib.DateTime.new_local(date.get_year(),
                                                   date.get_month(),
                                                   date.get_day_of_month(),
                                                   0, 1, 0);
        let daysAgo = todayMidnight.difference(dateMidnight) / GLib.TIME_SPAN_DAY;

        let format;
        let desktopSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        let clockFormat = desktopSettings.get_string('clock-format');
        let hasAmPm = date.format('%p') != '';

        if (clockFormat == '24h' || !hasAmPm) {
            if(daysAgo < 1) { // today
                /* Translators: Time in 24h format */
                format = _("%H\u2236%M");
            } else if(daysAgo <2) { // yesterday
                /* Translators: this is the word "Yesterday" followed by a
                 time string in 24h format. i.e. "Yesterday, 14:30" */
                // xgettext:no-c-format
                format = _("Yesterday, %H\u2236%M");
            } else if (daysAgo < 7) { // this week
                /* Translators: this is the week day name followed by a time
                 string in 24h format. i.e. "Monday, 14:30" */
                // xgettext:no-c-format
                format = _("%A, %H\u2236%M");
            } else if (date.get_year() == now.get_year()) { // this year
                /* Translators: this is the month name and day number
                 followed by a time string in 24h format.
                 i.e. "May 25, 14:30" */
                // xgettext:no-c-format
                format = _("%B %d, %H\u2236%M");
            } else { // before this year
                /* Translators: this is the month name, day number, year
                 number followed by a time string in 24h format.
                 i.e. "May 25 2012, 14:30" */
                // xgettext:no-c-format
                format = _("%B %d %Y, %H\u2236%M");
            }
        } else {
            if(daysAgo < 1) { // today
                /* Translators: Time in 12h format */
                format = _("%l\u2236%M %p");
            } else if(daysAgo <2) { // yesterday
                /* Translators: this is the word "Yesterday" followed by a
                 time string in 12h format. i.e. "Yesterday, 2:30 pm" */
                // xgettext:no-c-format
                format = _("Yesterday, %l\u2236%M %p");
            } else if (daysAgo < 7) { // this week
                /* Translators: this is the week day name followed by a time
                 string in 12h format. i.e. "Monday, 2:30 pm" */
                // xgettext:no-c-format
                format = _("%A, %l\u2236%M %p");
            } else if (date.get_year() == now.get_year()) { // this year
                /* Translators: this is the month name and day number
                 followed by a time string in 12h format.
                 i.e. "May 25, 2:30 pm" */
                // xgettext:no-c-format
                format = _("%B %d, %l\u2236%M %p");
            } else { // before this year
                /* Translators: this is the month name, day number, year
                 number followed by a time string in 12h format.
                 i.e. "May 25 2012, 2:30 pm"*/
                // xgettext:no-c-format
                format = _("%B %d %Y, %l\u2236%M %p");
            }
        }

        return date.format(format);
    },

    _onWindowStateEvent: function(widget, event) {
        let state = event.get_window().get_state();

        this._isFullscreen = (state & Gdk.WindowState.FULLSCREEN) != 0;
        this._isMaximized = (state & Gdk.WindowState.MAXIMIZED) != 0;
    },

    _handleKeyPress: function(self, event) {
        return this._search_bar.handle_event(event);
    },

    _onSizeAllocate: function(widget, allocation) {
        if (!this._isFullscreen && !this._isMaximized)
            this._currentSize = this.get_size(this);
    },

    _onDelete: function(widget, event) {
        this._settings.set_boolean ('window-maximized', this._isMaximized);
        this._settings.set_value('window-size',
                                 GLib.Variant.new('ai', this._currentSize));
    },

    _updateDecorations: function() {
        let layoutLeft = null;
        let layoutRight = null;

        let layout = this._gtkSettings.gtk_decoration_layout;
        if (layout) {
            let split = layout.split(':');

            layoutLeft = split[0] + ':';
            layoutRight = ':' + split[1];
        }

        this._titlebarLeft.set_decoration_layout(layoutLeft);
        this._titlebarRight.set_decoration_layout(layoutRight);
    },

    _activeRoomChanged: function(manager, room) {
        if (this._room) {
            this._room.disconnect(this._displayNameChangedId);
            this._room.disconnect(this._topicChangedId);
            this._room.disconnect(this._membersChangedId);
        }
        this._displayNameChangedId = 0;
        this._topicChangedId = 0;
        this._membersChangedId = 0;

        this._room = room;

        this._updateTitlebar();

        if (!this._room)
            return; // finished

        this._displayNameChangedId =
            this._room.connect('notify::display-name',
                               Lang.bind(this, this._updateTitlebar));
        this._topicChangedId =
            this._room.connect('notify::topic',
                               Lang.bind(this, this._updateTitlebar));
        this._membersChangedId =
            this._room.connect('members-changed',
                               Lang.bind(this, this._updateUserListLabel));
    },

    _addApplicationStyle: function() {
        let provider = new Gtk.CssProvider();
        let uri = 'resource:///org/gnome/Polari/css/application.css';
        let file = Gio.File.new_for_uri(uri);
        try {
            provider.load_from_file(Gio.File.new_for_uri(uri));
        } catch(e) {
            logError(e, "Failed to add application style");
        }
        Gtk.StyleContext.add_provider_for_screen(
            this.get_screen(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );
    },

    showJoinRoomDialog: function() {
        let dialog = new JoinDialog.JoinDialog({ transient_for: this });
        dialog.show();
    },

    _updateUserListLabel: function() {
        let numMembers = 0;

        if (this._room &&
            this._room.channel &&
            this._room.channel.has_interface(Tp.IFACE_CHANNEL_INTERFACE_GROUP))
            numMembers = this._room.channel.group_dup_members_contacts().length;

        let accessibleName = ngettext("%d user",
                                      "%d users", numMembers).format(numMembers);
        this._showUserListButton.get_accessible().set_name(accessibleName);
        this._showUserListButton.label = '%d'.format(numMembers);
    },

    _updateTitlebar: function() {
        let subtitle = '';
        if (this._room && this._room.topic) {
            let urls = Utils.findUrls(this._room.topic);
            let pos = 0;
            for (let i = 0; i < urls.length; i++) {
                let url = urls[i];
                let text = this._room.topic.substr(pos, url.pos - pos);
                let urlText = GLib.markup_escape_text(url.url, -1);
                subtitle += GLib.markup_escape_text(text, -1) +
                            '<a href="%s">%s</a>'.format(urlText, urlText);
                pos = url.pos + url.url.length;
            }
            subtitle += GLib.markup_escape_text(this._room.topic.substr(pos), -1);
        }

        if (this._subtitle != subtitle) {
            this._subtitle = subtitle;
            this.notify('subtitle');
            this.notify('subtitle-visible');
        }

        this.title = this._room ? this._room.display_name : null;
    }
});
