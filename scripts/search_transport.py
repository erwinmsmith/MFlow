"""Controller outages must bypass the native optimizer's skip-candidate retry."""
import http.client
import json
import urllib.error
import urllib.request


class ProviderUnavailable(BaseException):
    pass


class ControllerFailure(BaseException):
    pass


def request(endpoint, route, data=None):
    req = urllib.request.Request(endpoint + '/' + route, data=json.dumps(data or {}).encode(), headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=None) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        body = error.read().decode()
        try:
            result = json.loads(body)
        except ValueError:
            raise ControllerFailure(body) from None
        if result.get('unavailable'):
            raise ProviderUnavailable(body) from None
        if result.get('fatal'):
            raise ControllerFailure(body) from None
        raise RuntimeError(body) from None
    except (OSError, http.client.HTTPException, ValueError) as error:
        raise ControllerFailure(str(error)) from error
