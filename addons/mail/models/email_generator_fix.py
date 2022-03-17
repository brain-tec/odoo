import sys
from copy import deepcopy
from email import generator


class Generator(generator.Generator):
    """
    Override of class `email.generator.Generator` to implement the bugfix from
    https://github.com/python/cpython/pull/18074

    Background is that Python <= 3.7 only receives sercurity patches. But this one is not
    considered as such a patch.

    The code from the super class was copied and changed at the point between the comments
     START OF PATCH and END OF PATCH
    """

    def _write(self, msg):
        # We can't write the headers yet because of the following scenario:
        # say a multipart message includes the boundary string somewhere in
        # its body.  We'd have to calculate the new boundary /before/ we write
        # the headers so that we can write the correct Content-Type:
        # parameter.
        #
        # The way we do this, so as to make the _handle_*() methods simpler,
        # is to cache any subpart writes into a buffer.  The we write the
        # headers and the buffer contents.  That way, subpart handlers can
        # Do The Right Thing, and can still modify the Content-Type: header if
        # necessary.
        if sys.version_info >= (3, 8):
            return super(Generator, self)._write(msg)

        oldfp = self._fp
        try:
            self._munge_cte = None
            self._fp = sfp = self._new_buffer()
            self._dispatch(msg)
        finally:
            self._fp = oldfp
            munge_cte = self._munge_cte
            del self._munge_cte
        # If we munged the cte, copy the message again and re-fix the CTE.
        if munge_cte:
            msg = deepcopy(msg)

            #                   START OF PATCH
            # Taken from https://github.com/python/cpython/pull/18074 to
            # fix error if mail has no content-transfer-encoding header
            if msg.get('content-transfer-encoding') is None:
                msg['Content-Transfer-Encoding'] = munge_cte[0]
            else:
                msg.replace_header('content-transfer-encoding', munge_cte[0])
            #                   END OF PATCH
            msg.replace_header('content-type', munge_cte[1])
        # Write the headers.  First we see if the message object wants to
        # handle that itself.  If not, we'll do it generically.
        meth = getattr(msg, '_write_headers', None)
        if meth is None:
            self._write_headers(msg)
        else:
            meth(self)
        self._fp.write(sfp.getvalue())


generator.Generator = Generator
