# Compatibility layer that allows usage of the newest werkzeug package (3.1+)
# and restores older methods that are deprecated and discarded in newer
# werkzeug versions.

import sys
from urllib.parse import (
    parse_qsl,
    quote,
    quote_plus,
    unquote,
    unquote_plus,
    urlencode,
    urljoin,
    urlsplit,
    urlunsplit,
)

from werkzeug import urls
from werkzeug.datastructures import MultiDict


class URL:
    __slots__ = ('scheme', 'netloc', 'path', 'query', 'fragment')

    def __init__(self, scheme='', netloc='', path='', query='', fragment=''):
        self.scheme = scheme
        self.netloc = netloc
        self.path = path
        self.query = query
        self.fragment = fragment

    @classmethod
    def from_url(cls, value, scheme=None, allow_fragments=True):
        parsed = urlsplit(value, scheme=scheme or '', allow_fragments=allow_fragments)
        return cls(*parsed)

    @property
    def username(self):
        return urlsplit(self.to_url()).username

    @property
    def password(self):
        return urlsplit(self.to_url()).password

    @property
    def hostname(self):
        return urlsplit(self.to_url()).hostname

    @property
    def port(self):
        return urlsplit(self.to_url()).port

    def replace(self, **parts):
        new_parts = dict(zip(self.__slots__, self))
        new_parts.update(parts)
        return type(self)(**new_parts)

    def to_url(self):
        return urlunsplit((self.scheme, self.netloc, self.path, self.query, self.fragment))

    def decode_query(self, cls=MultiDict, include_empty=True, errors='replace', separator='&'):
        kwargs = {'keep_blank_values': include_empty, 'errors': errors}
        query = self.query
        if sys.version_info >= (3, 10):
            kwargs['separator'] = separator
        elif separator != '&':
            query = query.replace(separator, '&')
        pairs = parse_qsl(query, **kwargs)
        return cls(pairs)

    def join(self, url):
        return type(self).from_url(urljoin(self.to_url(), str(url)))

    def __iter__(self):
        return iter((self.scheme, self.netloc, self.path, self.query, self.fragment))

    def __str__(self):
        return self.to_url()


def url_parse(value, scheme=None, allow_fragments=True):
    if isinstance(value, URL):
        return value
    iri_to_uri = getattr(urls, 'iri_to_uri', None)
    if iri_to_uri and isinstance(value, str):
        value = iri_to_uri(value)
    return URL.from_url(value, scheme=scheme, allow_fragments=allow_fragments)


def url_quote(value, charset='utf-8', errors='strict', safe='/:'):
    if isinstance(value, bytes):
        return quote(value, safe=safe)
    return quote(value, safe=safe, encoding=charset, errors=errors)


def url_quote_plus(value, charset='utf-8', errors='strict', safe=''):
    if isinstance(value, bytes):
        return quote_plus(value, safe=safe)
    return quote_plus(value, safe=safe, encoding=charset, errors=errors)


def url_unquote(value, charset='utf-8', errors='replace'):
    return unquote(value, encoding=charset, errors=errors)


def url_unquote_plus(value, charset='utf-8', errors='replace'):
    return unquote_plus(value, encoding=charset, errors=errors)


def url_encode(query, charset='utf-8', encode_keys=False, sort=False, key=None, separator='&'):
    if isinstance(query, MultiDict):
        query = query.items(multi=True)
    if sort:
        query = sorted(query, key=key)
    encoded = urlencode(query, doseq=True, encoding=charset)
    return encoded if separator == '&' else encoded.replace('&', separator)


def url_decode(
    query,
    charset='utf-8',
    include_empty=True,
    errors='replace',
    separator='&',
    cls=MultiDict,
    max_num_fields=None,
):
    if isinstance(query, bytes):
        query = query.decode(charset, errors)
    kwargs = {'keep_blank_values': include_empty, 'errors': errors}
    if sys.version_info >= (3, 10):
        kwargs['separator'] = separator
    elif separator != '&':
        query = query.replace(separator, '&')
    if sys.version_info >= (3, 8) and max_num_fields is not None:
        kwargs['max_num_fields'] = max_num_fields
    pairs = parse_qsl(query, **kwargs)
    return cls(pairs)


def url_join(base, url):
    return urljoin(base, url)


def url_unparse(parts):
    return urlunsplit(parts)


for name, function in (
    ('URL', URL),
    ('url_parse', url_parse),
    ('url_quote', url_quote),
    ('url_quote_plus', url_quote_plus),
    ('url_unquote', url_unquote),
    ('url_unquote_plus', url_unquote_plus),
    ('url_encode', url_encode),
    ('url_decode', url_decode),
    ('url_join', url_join),
    ('url_unparse', url_unparse),
):
    if not hasattr(urls, name):
        setattr(urls, name, function)

URL = urls.URL
url_parse = urls.url_parse
url_quote = urls.url_quote
url_quote_plus = urls.url_quote_plus
url_unquote = urls.url_unquote
url_unquote_plus = urls.url_unquote_plus
url_encode = urls.url_encode
url_decode = urls.url_decode
url_join = urls.url_join
url_unparse = urls.url_unparse
