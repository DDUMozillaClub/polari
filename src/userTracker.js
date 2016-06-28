const Polari = imports.gi.Polari;
const Lang = imports.lang;
const Tp = imports.gi.TelepathyGLib;
const Signals = imports.signals;
/* unused imports: */
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;


const UserTracker = new Lang.Class({
    Name: 'UserTracker',

    _init: function(params) {
        this._contactMapping = new Map();

        /* not a widget, simply passing room */
        if (params.room) {
            this._room = params.room;
            this._room.connect('notify::channel', Lang.bind(this, this._onChannelChanged));

            this._onChannelChanged();
        }
        else {
            /* we decided that separate local/global trackers probably doesn't work, so don't mention it for now */
            //TODO: global user tracker
        }
    },

    _onChannelChanged: function() {
        if (this._room.channel) {
            if (this._room.type == Tp.HandleType.ROOM) {
                let members = this._room.channel.group_dup_members_contacts();

                //this._contactMapping = this._buildMapping(members);

                /* let instead of var */
                for (var i = 0; i < members.length; i++)
                    this._trackMember(members[i]);

                /* those can be done in _init() - otherwise we'd need to disconnect the signals to avoid adding contacts repeatedly */
                this._room.connect('member-renamed', Lang.bind(this, this._onMemberRenamed));
                this._room.connect('member-disconnected', Lang.bind(this, this._onMemberDisconnected));
                this._room.connect('member-kicked', Lang.bind(this, this._onMemberKicked));
                this._room.connect('member-banned', Lang.bind(this, this._onMemberBanned));
                this._room.connect('member-joined', Lang.bind(this, this._onMemberJoined));
                this._room.connect('member-left', Lang.bind(this, this._onMemberLeft));
            } else {
                let members = [this._room.channel.connection.self_contact, this._room.channel.target_contact];
                /* ignored return value, this does nothing */
                this._buildMapping(members);
            }
        } else {
            /* unnecessary check since _contactMapping creation was moved to _init */
            if(this._contactMapping) {
                this._contactMapping.clear();

                //this._room.disconnect('member-joined');
            }
        }

        /* with this._contactMapping initialization and signal connections in _init(), this is cleaner:
        if (this._room.channel) {
            let members;
            if (this._room.type == Tp.HandleType.ROOM)
                members = this._room.channel.group_dup_members_contacts();
            else
                members = [this._room.channel.connection.self_contact, this._room.channel.target_contact];

            members.forEach(m => { this._trackMember(m); });
        } else {
            this._contactMapping.clear();
        }
        */
    },

    /* scrap that, using _trackMember() is cleaner */
    _buildMapping: function(members) {
        let map = new Map();

        for (var i = 0; i < members.length; i++) {
            let currentBasenick = Polari.util_get_basenick(members[i].alias);
            if (map.has(currentBasenick))
                map.get(currentBasenick).push(members[i]);
            else
                map.set(currentBasenick, [members[i]]);
        }

        //log(map.get("raresv").length);

        return map;
    },

    _onMemberRenamed: function(room, oldMember, newMember) {
        log("rename " + oldMember.alias + " to " + newMember.alias);
        this._untrackMember(oldMember);
        this._trackMember(newMember);
    },

    _onMemberDisconnected: function(room, member, message) {
        this._untrackMember(member);
    },

    _onMemberKicked: function(room, member, actor) {
        this._untrackMember(member);
    },

    _onMemberBanned: function(room, member, actor) {
        this._untrackMember(member);
    },

    _onMemberJoined: function(room, member) {
        this._trackMember(member);
    },

    _onMemberLeft: function(room, member, message) {
        this._untrackMember(member);
    },

    _trackMember: function(member) {
        let baseNick = Polari.util_get_basenick(member.alias);

        /* nit: no braces */
        if (this._contactMapping.has(baseNick)) {
            this._contactMapping.get(baseNick).push(member);
        } else {
            this._contactMapping.set(baseNick, [member]);
        }

        /* This is equivalent to "this.emit('status-changed', ..., Tp.ConnectionPresenceType.AVAILABLE);",
           which isn't what we want - we want something like:
           if (this._contactMapping.size() == 1)
               this.emit('status-changed', ..., Tp.ConnectionPresenceType.AVAILABLE);
        */
        this._updateStatus(member);
    },

    _untrackMember: function(member) {
        let baseNick = Polari.util_get_basenick(member.alias);

        if (this._contactMapping.has(baseNick)) {
            let indexToDelete = this._contactMapping.get(baseNick).map(c => c.alias).indexOf(member.alias);

            if (indexToDelete > -1) {
                this._contactMapping.get(baseNick).splice(indexToDelete, 1);

                /* I'd not split this into a separate function for now (see comment in _trackMember) */
                this._updateStatus(member);
            }
        }
    },

    _updateStatus: function(member) {
        let baseNick = Polari.util_get_basenick(member.alias);

        if (this._contactMapping.has(baseNick)) {
            /* Nit: no braces */
            if (this._contactMapping.get(baseNick).length == 0) {
                /* some thoughts on parameters:
                    - while we only implement the local tracker, the room parameter looks a bit pointless
                    - I'm wondering whether member.alias or baseNick makes more sense
                */
                this.emit('status-changed', member.alias, this._room, Tp.ConnectionPresenceType.OFFLINE);
            } else {
                this.emit('status-changed', member.alias, this._room, Tp.ConnectionPresenceType.AVAILABLE);
            }
        }
    },

    getNickStatus: function(nickName) {
        let baseNick = Polari.util_get_basenick(nickName);

        /* reads easier IMHO with less nesting:
        if (this._contactMapping.has(baseNick) &&
            this._contactMapping.get(baseNick).length > 0)
            return Tp.ConnectionPresenceType.AVAILABLE;
        return Tp.ConnectionPresenceType.OFFLINE;

        Or maybe even:
        let contacts = this._contactMapping.get(baseNick) || [];
        return contacts.length == 0 ? Tp.ConnectionPresenceType.OFFLINE
                                    : Tp.ConnectionPresenceType.AVAILABLE;
        */
        if (this._contactMapping.has(baseNick)) {
            if (this._contactMapping.get(baseNick).length == 0) {
                return Tp.ConnectionPresenceType.OFFLINE;
            } else {
                return Tp.ConnectionPresenceType.AVAILABLE;
            }
        } else {
            return Tp.ConnectionPresenceType.OFFLINE;
        }
    },

    /* I don't like this:
       - all tracked contacts change status when we disconnect,
         but with this we expect all tracker users to keep track
         of the channel status to call this function themselves
         (compare to the connect-case, where users don't need to
          call a trackInitialMembers() function to get status-changed
          signals for connected nicks)
       - it relies on obscure implementation details:
         - our own ::notify::channel handler wipes all mappings
         - resetTracker called from some other ::notify::channel
           handler uses the mapping to emit 'status-changed' signals
         => if our own handler is called first, resetTracker() does not
            work as expected

        So no, this is bad API - the right place to do this is _onChannelChanged
        */
    resetTracker: function() {
        if (this._contactMapping) {
            this._contactMapping.forEach(function(value, key, map){
                let basenickContacts = value;

                basenickContacts.forEach(function(member){
                    this._untrackMember(member);
                });
            });

            this._contactMapping.clear();

        }
    },

    /* unused */
    resetBasenickMembers: function(basenick) {
        if (this._contactMapping.has(basenick)) {
            let basenickContacts = this._contactMapping.get(basenick);

            basenickContacts.forEach(function(member){
                    this._untrackMember(member);
            });
        }
    }
});
Signals.addSignalMethods(UserTracker.prototype);
