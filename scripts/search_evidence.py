"""Lossless references for repeated search evidence; never truncate agent programs."""
import json


def compact_evidence(value):
    dumps = lambda v: json.dumps(v, ensure_ascii=False, separators=(',', ':'))
    counts = {}
    reserved = False
    def count(v):
        nonlocal reserved
        if isinstance(v, dict) and '$evidence_ref' in v: reserved = True
        if isinstance(v, (dict, list, str)):
            key = dumps(v)
            if len(key) > 256: counts[key] = counts.get(key, 0) + 1
        if isinstance(v, dict):
            for child in v.values(): count(child)
        elif isinstance(v, list):
            for child in v: count(child)
    count(value)
    if reserved: return value
    definitions, indices = [], {}
    def encode(v):
        key = dumps(v)
        if counts.get(key, 0) > 1:
            if key not in indices:
                indices[key] = len(definitions)
                definitions.append(v)
            return {'$evidence_ref': indices[key]}
        if isinstance(v, dict): return {k: encode(child) for k, child in v.items()}
        if isinstance(v, list): return [encode(child) for child in v]
        return v
    # References only occur in data; definitions retain verbatim JSON values.
    data = encode(value)
    packed = {'encoding': 'Replace each $evidence_ref in data with definitions[index], without recursively expanding definitions.',
              'definitions': definitions, 'data': data}
    return packed if len(dumps(packed)) < len(dumps(value)) else value
