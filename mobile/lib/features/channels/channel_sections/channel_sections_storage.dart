import 'dart:async';
import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

String channelSectionsKey(String pubkey, {String? relayAuthority}) {
  if (relayAuthority == null || relayAuthority.isEmpty) {
    return 'buzz.channel-sections.v1:$pubkey';
  }
  final normalized = relayAuthority
      .trim()
      .replaceAll(RegExp(r'/+$'), '')
      .toLowerCase();
  return 'buzz.channel-sections.v1:$pubkey:${Uri.encodeComponent(normalized)}';
}

class ChannelSection {
  final String id;
  final String name;
  final String? icon;
  final int order;

  const ChannelSection({
    required this.id,
    required this.name,
    this.icon,
    required this.order,
  });

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    if (icon != null) 'icon': icon,
    'order': order,
  };

  factory ChannelSection.fromJson(Map<String, dynamic> json) => ChannelSection(
    id: json['id'] as String,
    name: json['name'] as String,
    icon: json['icon'] is String ? json['icon'] as String : null,
    order: json['order'] as int,
  );
}

class ChannelSectionStore {
  final int version;
  final List<ChannelSection> sections;
  final Map<String, String> assignments;

  const ChannelSectionStore({
    this.version = 1,
    this.sections = const [],
    this.assignments = const {},
  });

  Map<String, dynamic> toJson() => {
    'version': version,
    'sections': sections.map((s) => s.toJson()).toList(),
    'assignments': assignments,
  };

  factory ChannelSectionStore.fromJson(Map<String, dynamic> json) {
    final rawSections = json['sections'];
    final sections = <ChannelSection>[];
    if (rawSections is List) {
      for (final entry in rawSections) {
        if (entry is Map<String, dynamic> &&
            entry['id'] is String &&
            entry['name'] is String &&
            entry['order'] is int) {
          sections.add(ChannelSection.fromJson(entry));
        }
      }
    }

    final rawAssignments = json['assignments'];
    final assignments = <String, String>{};
    if (rawAssignments is Map) {
      for (final entry in rawAssignments.entries) {
        if (entry.key is String && entry.value is String) {
          assignments[entry.key as String] = entry.value as String;
        }
      }
    }

    // Strip assignments referencing sections that don't exist.
    final sectionIds = {for (final s in sections) s.id};
    assignments.removeWhere((_, sectionId) => !sectionIds.contains(sectionId));

    return ChannelSectionStore(
      version: 1,
      sections: sections,
      assignments: assignments,
    );
  }
}

class ChannelSectionsStorage {
  final String? _relayAuthority;
  final SharedPreferences _prefs;

  ChannelSectionsStorage(this._prefs, {String? relayAuthority})
    : _relayAuthority = relayAuthority;

  ChannelSectionStore read(String pubkey) {
    final key = channelSectionsKey(pubkey, relayAuthority: _relayAuthority);
    var raw = _prefs.getString(key);
    if ((raw == null || raw.isEmpty) &&
        _relayAuthority != null &&
        _relayAuthority.isNotEmpty) {
      final legacyKey = channelSectionsKey(pubkey);
      final legacyRaw = _prefs.getString(legacyKey);
      final legacyStore = _parse(legacyRaw);
      if (legacyStore != null) {
        final scopedPersisted = _prefs.setString(
          key,
          jsonEncode(legacyStore.toJson()),
        );
        unawaited(
          scopedPersisted.then((persisted) {
            if (persisted) unawaited(_prefs.remove(legacyKey));
          }),
        );
        return legacyStore;
      }
      raw = legacyRaw;
    }
    return _parse(raw) ?? const ChannelSectionStore();
  }

  ChannelSectionStore? _parse(String? raw) {
    if (raw == null || raw.isEmpty) return null;
    try {
      final parsed = jsonDecode(raw);
      if (parsed is! Map<String, dynamic> || parsed['version'] != 1) {
        return null;
      }
      return ChannelSectionStore.fromJson(parsed);
    } catch (_) {
      return null;
    }
  }

  void write(String pubkey, ChannelSectionStore store) {
    _prefs.setString(
      channelSectionsKey(pubkey, relayAuthority: _relayAuthority),
      jsonEncode(store.toJson()),
    );
  }
}
