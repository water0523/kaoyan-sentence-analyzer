"""Optional integration check with the real Anki backend, using a temporary collection.

Run: node tests/anki-sample.cjs
     python -m pip install anki
     python tests/anki-import.py
Never opens or modifies a user's Anki profile.
"""
from pathlib import Path
from tempfile import TemporaryDirectory
from anki.collection import Collection, ImportCsvRequest
from anki.import_export_pb2 import CsvMetadata

sample = Path(__file__).resolve().parent.parent / 'test-results/anki-sample.txt'
sample.parent.mkdir(exist_ok=True)
with TemporaryDirectory(prefix='kaoyan-anki-', dir=sample.parent) as tmp:
    Path(tmp).resolve().relative_to(sample.parent.resolve())
    col = Collection(str(Path(tmp) / 'collection.anki2'))
    try:
        metadata = col.get_csv_metadata(str(sample), None)
        assert metadata.delimiter == CsvMetadata.TAB
        assert metadata.is_html
        assert metadata.deck_column == 3
        basic = next(m for m in col.models.all() if len(m['flds']) == 2 and len(m['tmpls']) == 1)
        metadata.global_notetype.id = basic['id']
        del metadata.global_notetype.field_columns[:]
        metadata.global_notetype.field_columns.extend([1, 2])
        metadata.match_scope = CsvMetadata.NOTETYPE_AND_DECK
        metadata.dupe_resolution = CsvMetadata.UPDATE
        col.import_csv(ImportCsvRequest(path=str(sample), metadata=metadata))
        assert col.note_count() == 2, col.note_count()
        deck_names = {d.name for d in col.decks.all_names_and_ids()}
        assert '考研生词::未分类' in deck_names
        assert '考研生词::真题' in deck_names
        notes = [col.get_note(nid) for nid in col.find_notes('')]
        assert all(n.fields[0] == 'R&amp;D' for n in notes), [n.fields for n in notes]
        back = next(n.fields[1] for n in notes if 'another' in n.fields[1])
        assert '&quot;研究&quot;<br>开发 &lt;b&gt;' in back
        assert 'He said &quot;hi&quot;.' in back
        assert '中文' in back
        col.import_csv(ImportCsvRequest(path=str(sample), metadata=metadata))
        assert col.note_count() == 2, 'Repeated import duplicated cards'
        print('Anki import OK: 2 notes, 2 folder decks, escaped HTML, multiple contexts, repeat import updates')
    finally:
        col.close()
