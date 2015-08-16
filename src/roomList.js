const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const Tp = imports.gi.TelepathyGLib;

const ChatroomManager = imports.chatroomManager;
const Lang = imports.lang;

const RoomRow = new Lang.Class({
    Name: 'RoomRow',

    _init: function(room) {
        this._createWidget(room.icon);

        let app = Gio.Application.get_default();
        this.widget.room = room;

        let menu = new Gio.Menu();
        menu.append(room.type == Tp.HandleType.ROOM ? _("Leave chatroom")
                                                    : _("End conversation"),
                    'app.leave-room(("%s", ""))'.format(this.widget.room.id));

        this._popover = Gtk.Popover.new_from_model(this.widget, menu);
        this._popover.position = Gtk.PositionType.BOTTOM;
        this._eventBox.connect('button-release-event',
                            Lang.bind(this, this._onButtonRelease));
        this.widget.connect('key-press-event',
                            Lang.bind(this, this._onKeyPress));

        room.connect('notify::channel', Lang.bind(this,
            function() {
                if (!room.channel)
                    return;
                room.channel.connect('message-received',
                                     Lang.bind(this, this._updatePending));
                room.channel.connect('pending-message-removed',
                                     Lang.bind(this, this._updatePending));
            }));
        room.bind_property('display-name', this._roomLabel, 'label',
                           GObject.BindingFlags.SYNC_CREATE);

        this._updatePending();
    },

    selected: function() {
        if (!this.widget.room.channel)
            this._updatePending();
    },

    _updatePending: function() {
        let room = this.widget.room;

        let pending;
        let numPendingHighlights;

        if (room.channel) {
            pending = room.channel.dup_pending_messages();
            if (room.channel.has_interface(Tp.IFACE_CHANNEL_INTERFACE_GROUP))
                numPendingHighlights = pending.filter(function(m) {
                    return room.should_highlight_message(m);
                }).length;
            else
                numPendingHighlights = pending.length;
        } else {
            pending = [];
            numPendingHighlights = 0;
        }

        this._counter.label = numPendingHighlights.toString();
        this._counter.opacity = numPendingHighlights > 0 ? 1. : 0.;

        let context = this.widget.get_style_context();
        if (pending.length == 0)
            context.add_class('inactive');
        else
            context.remove_class('inactive');
    },

    _onButtonRelease: function(w, event) {
        let [, button] = event.get_button();
        if (button != Gdk.BUTTON_SECONDARY)
            return Gdk.EVENT_PROPAGATE;

        this._popover.show();

        return Gdk.EVENT_STOP;
    },

    _onKeyPress: function(w, event) {
        let [, keyval] = event.get_keyval();
        let [, mods] = event.get_state();
        if (keyval != Gdk.KEY_Menu &&
            !(keyval == Gdk.KEY_F10 &&
              mods & Gdk.ModifierType.SHIFT_MASK))
            return Gdk.EVENT_PROPAGATE;

        this._popover.show();

        return Gdk.EVENT_STOP;
    },

    _createWidget: function(gicon) {
        this.widget = new Gtk.ListBoxRow({ margin_bottom: 4 });

        this._eventBox = new Gtk.EventBox();
        this.widget.add(this._eventBox);

        let box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL,
                                margin_start: 8, margin_end: 8,
                                margin_top: 2, margin_bottom: 2, spacing: 6 });
        this._eventBox.add(box);

        if (gicon) {
            let icon = new Gtk.Image({ gicon: gicon,
                                       icon_size: Gtk.IconSize.MENU,
                                       valign: Gtk.Align.BASELINE });
            box.add(icon);
        }

        this._roomLabel = new Gtk.Label({ hexpand: true,
                                          ellipsize: Pango.EllipsizeMode.END,
                                          halign: Gtk.Align.START,
                                          valign: Gtk.Align.BASELINE });
        box.add(this._roomLabel);

        let frame = new Gtk.AspectFrame({ obey_child: false,
                                          shadow_type: Gtk.ShadowType.NONE });
        box.add(frame);

        this._counter = new Gtk.Label({ width_chars: 2 });
        this._counter.get_style_context().add_class('pending-messages-count');
        frame.add(this._counter);

        this.widget.show_all();
    }
});

const RoomListHeader = new Lang.Class({
    Name: 'RoomListHeader',

    _init: function(account) {
        this._account = account;

        this._networkMonitor = Gio.NetworkMonitor.get_default();

        this._app = Gio.Application.get_default();

        this.widget = new Gtk.Button({ sensitive: false, margin_bottom: 4,
                                       margin_start: 7, margin_end: 7,
                                       hexpand: true, focus_on_click: false })
        this.widget.get_style_context().remove_class('button');
        this.widget.get_style_context().add_class('room-list-header');
        this.widget.connect('clicked', Lang.bind(this, function () {
            this._popover.show_all();
        }));

        let headerBox = new Gtk.Box({ spacing: 2, hexpand: true,
                                      orientation: Gtk.Orientation.HORIZONTAL });
        this.widget.add(headerBox);
        let label = new Gtk.Label({ xalign: 0, hexpand: true, max_width_chars: 15,
                                    ellipsize: Pango.EllipsizeMode.END });
        this.widget.get_style_context().remove_class('button');
        account.bind_property('display-name', label, 'label',
                              GObject.BindingFlags.SYNC_CREATE);
        headerBox.add(label);

        this._iconStack = new Gtk.Stack({ vhomogeneous: true, valign: Gtk.Align.CENTER,
                                          margin_end: 4 });
        this._iconStack.transition_type = Gtk.StackTransitionType.CROSSFADE;

        let errorIcon = new Gtk.Image({ icon_name: 'dialog-error-symbolic',
                                        halign: Gtk.Align.END });

        this._popover = new Gtk.Popover({ modal: true,
                                          position: Gtk.PositionType.BOTTOM });
        let popoverBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL,
                                       margin: 12, spacing: 3 });
        this._popoverLabel = new Gtk.Label({ wrap: true, max_width_chars: 30,
                                             halign: Gtk.Align.START, xalign: 0 });
        this._popoverTitle = new Gtk.Label({ wrap: true, max_width_chars: 30,
                                             use_markup: true, xalign: 0,
                                             halign: Gtk.Align.START });
        this._popoverTitle.label = '<b>' + _("Connection Error") + '</b>';
        this._popoverButton = new Gtk.Button({ valign: Gtk.Align.CENTER, hexpand: true,
                                               margin_top: 15, halign: Gtk.Align.END });
        this._popoverButton.connect('clicked', Lang.bind(this,
            function() {
                this._popover.hide();
            }));
        popoverBox.add(this._popoverTitle);
        popoverBox.add(this._popoverLabel);
        popoverBox.add(this._popoverButton);
        this._popover.add(popoverBox);
        this._popover.relative_to = errorIcon;

        this._iconStack.add_named(errorIcon, 'error');

        let connecting = new Gtk.Spinner({ active: true, halign: Gtk.Align.START });
        this._iconStack.add_named(connecting, 'connecting');

        this._iconStack.add_named(new Gtk.Box(), 'none');

        this._account.connect('notify::connection-status', Lang.bind(this, this._updateConnectionStatusIcon));
        headerBox.add(this._iconStack);
        this.widget.show_all();

        this._updateConnectionStatusIcon();

    },

    _updateConnectionStatusIcon: function() {
        let status = this._account.connection_status;
        let reason = this._account.connection_status_reason;
        let isError = (status == Tp.ConnectionStatus.DISCONNECTED &&
                       reason != Tp.ConnectionStatusReason.REQUESTED);

        let child = 'none';
        if (status == Tp.ConnectionStatus.CONNECTING) {
            if (this._networkMonitor.network_available)
                child = 'connecting';
        } else if (isError) {
            child = 'error';
            switch (this._account.connection_error) {

                case Tp.error_get_dbus_name(Tp.Error.CONNECTION_REFUSED):
                case Tp.error_get_dbus_name(Tp.Error.NETWORK_ERROR): {
                    this._popoverLabel.label = _("Please check your connection details.")

                    this._popoverButton.label =  _("Edit Connection");
                    this._popoverButton.action_name = 'app.edit-connection';
                    this._popoverButton.action_target = new GLib.Variant('o', this._account.get_object_path());
                    break;
                }

                case Tp.error_get_dbus_name(Tp.Error.CERT_REVOKED):
                case Tp.error_get_dbus_name(Tp.Error.CERT_INSECURE):
                case Tp.error_get_dbus_name(Tp.Error.CERT_LIMIT_EXCEEDED):
                case Tp.error_get_dbus_name(Tp.Error.CERT_INVALID):
                case Tp.error_get_dbus_name(Tp.Error.ENCRYPTION_ERROR):
                case Tp.error_get_dbus_name(Tp.Error.CERT_NOT_PROVIDED):
                case Tp.error_get_dbus_name(Tp.Error.ENCRYPTION_NOT_AVAILABLE):
                case Tp.error_get_dbus_name(Tp.Error.CERT_UNTRUSTED):
                case Tp.error_get_dbus_name(Tp.Error.CERT_EXPIRED):
                case Tp.error_get_dbus_name(Tp.Error.CERT_NOT_ACTIVATED):
                case Tp.error_get_dbus_name(Tp.Error.CERT_HOSTNAME_MISMATCH):
                case Tp.error_get_dbus_name(Tp.Error.CERT_FINGERPRINT_MISMATCH):
                case Tp.error_get_dbus_name(Tp.Error.CERT_SELF_SIGNED): {
                    this._popoverLabel.label = _("Could not make connection in a safe way.");
                    this._popoverButton.label =  _("Continue Anyway");
                    this._popoverButton.action_name = 'app.reconnect-without-encryption';
                    this._popoverLabel.label = _("The connection is not safe.");
                    this._popoverButton.action_target = GLib.Variant.new('o', this._account.get_object_path());
                    break;
                }

                case Tp.error_get_dbus_name(Tp.Error.AUTHENTICATION_FAILED): {
                    this._popoverLabel.label = _("Authentication failed.");
                    this._popoverButton.label = _("Try again");
                    this._popoverButton.action_name = 'app.reconnect-account';
                    this._popoverButton.action_target = GLib.Variant.new('o', this._account.get_object_path());
                    break;
                }

                case Tp.error_get_dbus_name(Tp.Error.CONNECTION_FAILED):
                case Tp.error_get_dbus_name(Tp.Error.CONNECTION_LOST):
                case Tp.error_get_dbus_name(Tp.Error.CONNECTION_REPLACED):
                case Tp.error_get_dbus_name(Tp.Error.SERVICE_BUSY): {
                    this._popoverLabel.label = _("The server is busy.");
                    this._popoverButton.label = _("Try again");
                    this._popoverButton.action_name = 'app.reconnect-account';
                    this._popoverButton.action_target = GLib.Variant.new('o', this._account.get_object_path());
                    break;
                }

                default:
                    this._popoverLabel.label = _("Failed to connect for an unknown reason.");
                    this._popoverButton.label = _("Try again");
                    this._popoverButton.action_name = 'app.reconnect-account';
                    this._popoverButton.action_target = GLib.Variant.new('o', this._account.get_object_path());
                    break;
            }
        }
        this.widget.sensitive = isError;
        this._iconStack.visible_child_name = child;
    },
});

const RoomList = new Lang.Class({
    Name: 'RoomList',

    _init: function() {
        this.widget = new Gtk.ListBox({ hexpand: false });

        this.widget.set_selection_mode(Gtk.SelectionMode.BROWSE);
        this.widget.set_header_func(Lang.bind(this, this._updateHeader));
        this.widget.set_sort_func(Lang.bind(this, this._sort));

        this._roomRows = {};
        this._selectedRows = 0;
        this._selectionMode = false;

        this.widget.connect('row-selected',
                            Lang.bind(this, this._onRowSelected));

        this._roomManager = ChatroomManager.getDefault();
        this._roomManager.connect('room-added',
                                  Lang.bind(this, this._roomAdded));
        this._roomManager.connect('room-removed',
                                  Lang.bind(this, this._roomRemoved));
        this._roomManager.connect('active-changed',
                                  Lang.bind(this, this._activeRoomChanged));

        let app = Gio.Application.get_default();
        this._leaveAction = app.lookup_action('leave-room');
        this._leaveAction.connect('activate',
                                  Lang.bind(this, this._onLeaveActivated));

        let action;
        action = app.lookup_action('next-room');
        action.connect('activate', Lang.bind(this,
            function() {
                this._moveSelection(Gtk.DirectionType.DOWN);
            }));
        action = app.lookup_action('previous-room');
        action.connect('activate', Lang.bind(this,
            function() {
                this._moveSelection(Gtk.DirectionType.UP);
            }));
        action = app.lookup_action('first-room');
        action.connect('activate', Lang.bind(this,
            function() {
                let row = this.widget.get_row_at_index(0);
                if (row)
                    this.widget.select_row(row);
            }));
        action = app.lookup_action('last-room');
        action.connect('activate', Lang.bind(this,
            function() {
                let nRows = this._roomManager.roomCount;
                let row = this.widget.get_row_at_index(nRows - 1);
                if (row)
                    this.widget.select_row(row);
            }));
        action = app.lookup_action('nth-room');
        action.connect('activate', Lang.bind(this,
            function(action, param) {
                let n = param.get_int32();
                if (n > this._roomManager.roomCount)
                    return;
                this.widget.select_row(this.widget.get_row_at_index(n - 1));
            }));
    },

    _onLeaveActivated: function(action, param) {
        let [id, ] = param.deep_unpack();
        let row = this._roomRows[id].widget;

        this._moveSelectionFromRow(row);
        row.hide();
    },

    _moveSelection: function(direction) {
        let current = this.widget.get_selected_row();
        if (!current)
            return;
        let inc = direction == Gtk.DirectionType.UP ? -1 : 1;
        let row = this.widget.get_row_at_index(current.get_index() + inc);
        if (row)
            this.widget.select_row(row);
    },

    _moveSelectionFromRow: function(row) {
        if (this._roomManager.roomCount == 0)
            return;

        let activeRoom = this._roomManager.getActiveRoom();
        let current = this._roomRows[activeRoom.id].widget;

        if (current != row)
            return;

        let selected = this.widget.get_selected_row();
        let newActive = null;

        this.widget.select_row(row);
        this._moveSelection(row.get_index() == 0 ? Gtk.DirectionType.DOWN
                                                 : Gtk.DirectionType.UP);

        let newSelected = this.widget.get_selected_row();
        if (newSelected != row)
            newActive = newSelected.room;
        this._roomManager.setActiveRoom(newActive);

        if (selected != row)
            this.widget.select_row(selected);
    },

    _roomAdded: function(roomManager, room) {
        let roomRow = new RoomRow(room);
        this.widget.add(roomRow.widget);
        this._roomRows[room.id] = roomRow;

        roomRow.widget.connect('destroy', Lang.bind(this,
            function(w) {
                delete this._roomRows[w.room.id];
            }));
    },

    _roomRemoved: function(roomManager, room) {
        let roomRow = this._roomRows[room.id];
        if (!roomRow)
            return;

        this._moveSelectionFromRow(roomRow.widget);
        roomRow.widget.destroy();
        delete this._roomRows[room.id];
    },

    _activeRoomChanged: function(roomManager, room) {
        if (!room)
            return;
        let roomRow = this._roomRows[room.id];
        if (!roomRow)
            return;

        let row = roomRow.widget;
        row.can_focus = false;
        this.widget.select_row(row);
        row.can_focus = true;
    },

    _onRowSelected: function(w, row) {
        this._roomManager.setActiveRoom(row ? row.room : null);
        if (row)
            this._roomRows[row.room.id].selected();
    },

    _updateHeader: function(row, before) {
        let getAccount = function(row) {
            return row ? row.room.account : null;
        };
        let beforeAccount = getAccount(before);
        let account = getAccount(row);

        if (beforeAccount == account) {
            row.set_header(null);
            return;
        }

        if (row.get_header())
            return;

        let roomListHeader = new RoomListHeader(account);
        row.set_header(roomListHeader.widget);
    },

    _sort: function(row1, row2) {
        return row1.room.compare(row2.room);
    }
});
