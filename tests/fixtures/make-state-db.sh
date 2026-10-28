#!/bin/sh
# Builds one VS Code `state.vscdb` (a SQLite file with an ItemTable) for the disabled-extension reader's tests.
#
#   make-state-db.sh <file> [options]
#
# By default: an ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB, as VS Code makes it) holding the
# key `extensionsIdentifiers/disabled` with an empty list `[]`, and one unrelated key. Options:
#
#   --disabled id1,id2    the list holds these ids, as VS Code writes it: [{"id":"id1"},{"id":"id2"}]
#   --bare id1,id2        the list holds these ids as bare strings: ["id1","id2"]
#   --raw <text>          store this text as the value, verbatim (not JSON, a JSON object, a number ...)
#   --null                store SQL NULL as the value
#   --no-key              the table exists but the key is not in it
#   --no-table            the file is a database, but has no ItemTable
#   --size-mb <n>         add about <n> MB of other rows (random bytes), for the large-copy test
#   --wal                 leave the key in a `-wal` file next to the database (with its `-shm`): the main file
#                         alone does NOT hold it, so only a copy that includes the sidecars sees it
#   --corrupt             not a database at all (text)
#   --truncated           a real database cut to a third of its size
#
# Needs only the system `sqlite3`. Writes only <file> and its sidecars; an existing <file> is replaced.
set -eu

KEY='extensionsIdentifiers/disabled'
file=${1:?usage: make-state-db.sh <file> [options]}
shift

mode=list
value='[]'
size=0
wal=0
corrupt=0
truncated=0

json_objects() { # id1,id2 -> [{"id":"id1"},{"id":"id2"}]
  printf '%s' "$1" | awk -v RS=, 'BEGIN { printf "[" } { if (NR > 1) printf ","; printf "{\"id\":\"%s\"}", $0 } END { printf "]" }'
}
json_strings() { # id1,id2 -> ["id1","id2"]
  printf '%s' "$1" | awk -v RS=, 'BEGIN { printf "[" } { if (NR > 1) printf ","; printf "\"%s\"", $0 } END { printf "]" }'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --disabled) value=$(json_objects "${2:?--disabled needs a list}"); shift 2 ;;
    --bare) value=$(json_strings "${2:?--bare needs a list}"); shift 2 ;;
    --raw) value=${2?--raw needs a value}; shift 2 ;;
    --null) mode=null; shift ;;
    --no-key) mode=nokey; shift ;;
    --no-table) mode=notable; shift ;;
    --size-mb) size=${2:?--size-mb needs a number}; shift 2 ;;
    --wal) wal=1; shift ;;
    --corrupt) corrupt=1; shift ;;
    --truncated) truncated=1; shift ;;
    *) echo "make-state-db.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$(dirname "$file")"
rm -f "$file" "$file-wal" "$file-shm" "$file-journal"

if [ "$corrupt" = 1 ]; then
  printf 'this is not a SQLite database\n' >"$file"
  exit 0
fi

escaped=$(printf '%s' "$value" | sed "s/'/''/g")
table="CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);"

if [ "$mode" = notable ]; then
  sqlite3 "$file" "CREATE TABLE Other (key TEXT, value TEXT); INSERT INTO Other VALUES ('x', 'y');"
  exit 0
fi

sqlite3 "$file" "$table INSERT INTO ItemTable VALUES ('workbench.sideBar.visible', 'true');"

if [ "$size" -gt 0 ]; then
  sqlite3 "$file" "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < $size) INSERT INTO ItemTable SELECT 'filler/' || x, randomblob(1048576) FROM c;"
fi

insert=""
case "$mode" in
  list) insert="INSERT INTO ItemTable VALUES ('$KEY', '$escaped');" ;;
  null) insert="INSERT INTO ItemTable VALUES ('$KEY', NULL);" ;;
  nokey) insert="" ;;
esac

if [ "$wal" = 1 ]; then
  # While the connection is open the new row is only in the -wal file: copy the three files then, and put the
  # copies in place once sqlite3 has exited (a clean exit would have folded the -wal into the main file).
  sqlite3 "$file" >/dev/null <<SQL
PRAGMA journal_mode=WAL;
PRAGMA wal_autocheckpoint=0;
$insert
.shell cp "$file" "$file.keep"
.shell cp "$file-wal" "$file.keep-wal"
.shell cp "$file-shm" "$file.keep-shm"
SQL
  rm -f "$file" "$file-wal" "$file-shm"
  mv "$file.keep" "$file"
  mv "$file.keep-wal" "$file-wal"
  mv "$file.keep-shm" "$file-shm"
elif [ -n "$insert" ]; then
  sqlite3 "$file" "$insert"
fi

if [ "$truncated" = 1 ]; then
  bytes=$(wc -c <"$file" | tr -d ' ')
  dd if="$file" of="$file.cut" bs=1 count=$((bytes / 3)) 2>/dev/null
  mv "$file.cut" "$file"
fi
