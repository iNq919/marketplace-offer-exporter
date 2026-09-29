# Changelog

Historia zmian rozszerzenia Marketplace Offer Exporter.

## v1.2.0

- Rozdzielono stan, wyniki i historię dla Allegro oraz Ceneo.
- Dodano równoległe uruchamianie dwóch serwisów.
- Dodano pomijanie wcześniej poprawnie wyeksportowanych ID i import historii TXT/JSON.
- Rozbudowano diagnostykę paginacji i liczników.
- Dodano spokojniejsze retry/backoff dla 403, 429 i 5xx.
- Dołączono pomocnicze pliki historii z wcześniejszych eksportów.

## v1.1.1

- Naprawiono błąd `Could not establish connection. Receiving end does not exist.` po instalacji lub przeładowaniu rozszerzenia.
- Popup automatycznie wstrzykuje `content.js`, gdy odbiornik wiadomości nie jest jeszcze dostępny.
- Obsługa eksportu Allegro i Ceneo, TXT/JSON oraz trybu AI compact / pełnych opisów.
